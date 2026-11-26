// Estimates a job BEFORE running it, and applies the CPU rule: a job that would keep this PC's CPU at or
// above the limit (default 50%) for the limit's minutes or more (default 5) goes to Kaggle.
//
// Two ways to estimate:
//   1. by calculation, when the size of the work is known:
//        node estimate.mjs --params-b 1.5 --tokens 2000000        transformer inference: 2 x params x tokens
//        node estimate.mjs --gflop 50000                           any job whose total GFLOP you know
//      It uses the speeds kaggle-offload measured (ko.py bench): this PC, Kaggle CPU, Kaggle T4.
//   2. with a pilot: run the real command on a few items, measure time and CPU, project on all of them:
//        node estimate.mjs --pilot "python transcribe.py --limit 2" --items-pilot 2 --items-total 120
//      CPU is sampled for the whole machine every half second while the pilot runs.
//
// Options: --cpu-only (the job can't use a GPU: the alternative is a Kaggle CPU session)
//          --cpu-max 50 --minutes-max 5 (override the rule; defaults in ~/.green-compute/config.json)
//          --label "whisper on 120 files" (shown in the control room) --json
// Exit code 0 = run here, 10 = send to Kaggle. Nothing is sent anywhere by this script.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { readConfig, KAGGLE_DIR, DEFAULT_PORT } from '../control-room/lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const num = (k, d) => (opt(k) !== undefined ? Number(opt(k)) : d);
const cfg = readConfig();
const cpuMax = num('cpu-max', cfg.cpuMaxPercent);
const minutesMax = num('minutes-max', cfg.minutesMax ?? cfg.cpuMaxMinutes);
const cpuOnly = args.includes('--cpu-only');
const label = opt('label', '');

// speeds measured by kaggle-offload (GFLOPS); rough fallbacks when no benchmark exists yet
let bench = null;
try { bench = JSON.parse(fs.readFileSync(join(KAGGLE_DIR, 'bench.json'), 'utf8')); } catch {}
const pcPeak = bench?.pc?.gflops_fp32 ?? 50;
const kCpuPeak = bench?.kaggle_cpu?.gflops_fp32 ?? 140;
const gpuPeak = bench?.kaggle_gpu?.gflops_fp16 ?? 20000;
// real models reach only part of a matmul benchmark's peak. These two factors are a first rough guess
// (GPU decoding is often memory-bound, far from the fp16 peak): calibrate them on real kaggle-offload runs.
const EFF = { cpu: 0.5, gpu: 0.1 };

function sampleCpu() {
  let prev = os.cpus();
  return () => {
    const now = os.cpus(); let idle = 0, total = 0;
    now.forEach((c, i) => { const p = prev[i]?.times || c.times; for (const k in c.times) total += c.times[k] - p[k]; idle += c.times.idle - p.idle; });
    prev = now;
    return total ? (1 - idle / total) * 100 : 0;
  };
}

async function pilot(cmd) {
  const read = sampleCpu(); const samples = [];
  const t0 = Date.now();
  const timer = setInterval(() => samples.push(read()), 500);
  const code = await new Promise(res => {
    const p = spawn(cmd, { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', c => res(c ?? 1)); p.on('error', () => res(1));
  });
  clearInterval(timer);
  const sec = (Date.now() - t0) / 1000;
  const cpu = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : read();
  return { sec, cpu, code };
}

let est;
if (opt('pilot')) {
  const itemsPilot = num('items-pilot', 1), itemsTotal = num('items-total', 1);
  const p = await pilot(opt('pilot'));
  const totalSec = p.sec * (itemsTotal / Math.max(1, itemsPilot));
  // the pilot used this much of the PC's compute; the same work on Kaggle runs at Kaggle's speed
  const usedHere = pcPeak * EFF.cpu * Math.max(0.05, p.cpu / 100);
  const minutesAt = speed => +(totalSec * usedHere / speed / 60).toFixed(2);
  est = { method: 'pilot', pilotSec: +p.sec.toFixed(1), pilotExit: p.code, cpuPercent: Math.round(p.cpu),
    localMinutes: +(totalSec / 60).toFixed(1), items: { pilot: itemsPilot, total: itemsTotal },
    kaggleCpuMinutes: minutesAt(kCpuPeak * EFF.cpu),
    kaggleGpuMinutes: cpuOnly ? null : minutesAt(gpuPeak * EFF.gpu),
    speeds: { pc: pcPeak, kaggleCpu: kCpuPeak, kaggleGpuFp16: gpuPeak, measured: !!bench } };
  if (p.code !== 0) est.warning = `the pilot exited with code ${p.code}: the estimate may be wrong`;
  if (!cpuOnly) est.note = 'GPU time assumes the job is model work that a GPU speeds up; pass --cpu-only if it is not';
} else {
  const gflop = opt('gflop') !== undefined ? num('gflop') : num('params-b', 0) * 1e9 * 2 * num('tokens', 0) / 1e9;
  if (!gflop) { console.error('Pass --gflop, or --params-b with --tokens, or --pilot "<command>" with --items-pilot and --items-total'); process.exit(1); }
  const localSec = gflop / (pcPeak * EFF.cpu);
  // model inference on CPU keeps every core busy: the CPU sits near 100% for the whole run
  est = { method: 'calculation', gflop: Math.round(gflop), cpuPercent: 95, localMinutes: +(localSec / 60).toFixed(1),
    kaggleCpuMinutes: +(gflop / (kCpuPeak * EFF.cpu) / 60).toFixed(1),
    kaggleGpuMinutes: cpuOnly ? null : +(gflop / (gpuPeak * EFF.gpu) / 60).toFixed(2),
    speeds: { pc: pcPeak, kaggleCpu: kCpuPeak, kaggleGpuFp16: gpuPeak, measured: !!bench } };
}

// Two rules, either one sends the job to Kaggle:
//  - CPU: it would keep the CPU at or above the limit for the limit's minutes or more;
//  - time: it is longer than the limit's minutes and Kaggle, setup included, would take less than half.
const SETUP_MIN = 3; // a Kaggle run: queue, install and model loading (measured ~1.5-2 min with the cache)
const remoteMin = cpuOnly ? est.kaggleCpuMinutes : est.kaggleGpuMinutes;
const remoteTotal = remoteMin != null ? +(remoteMin + SETUP_MIN).toFixed(1) : null;
const cpuRule = est.cpuPercent >= cpuMax && est.localMinutes >= minutesMax;
const timeRule = remoteTotal != null && est.localMinutes >= minutesMax && remoteTotal < est.localMinutes / 2;
const over = cpuRule || timeRule;
est.rule = { cpuMaxPercent: cpuMax, cpuMaxMinutes: minutesMax, setupMinutes: SETUP_MIN, cpuRule, timeRule };
est.kaggleTotalMinutes = remoteTotal;
est.minutesSaved = over && remoteTotal != null ? +(est.localMinutes - remoteTotal).toFixed(1) : 0;
est.where = over ? (cpuOnly ? 'kaggle-cpu' : 'kaggle-gpu') : 'pc';
const there = cpuOnly ? 'a Kaggle CPU session (no quota used)' : "Kaggle's GPU";
const why = [];
if (cpuRule) why.push(`it would keep the CPU at ~${est.cpuPercent}% for ~${est.localMinutes} min (limit ${cpuMax}% for ${minutesMax} min)`);
if (timeRule) why.push(`~${remoteTotal} min there instead of ~${est.localMinutes} min here, setup included`);
est.reason = over
  ? `${there}: ${why.join('; ')}. The PC stays free.`
  : `run it here: ~${est.localMinutes} min at ~${est.cpuPercent}% CPU${remoteTotal != null ? `, Kaggle would take ~${remoteTotal} min with setup` : ''}`;
est.label = label;

// tell the control room, if it is open
try {
  await fetch(`http://127.0.0.1:${process.env.GREEN_COMPUTE_PORT || DEFAULT_PORT}/event`, {
    method: 'POST', body: JSON.stringify({ type: 'estimate', ...est }), signal: AbortSignal.timeout(1500) });
} catch {}

if (args.includes('--json')) console.log(JSON.stringify(est, null, 2));
else {
  console.log(`${label ? label + ': ' : ''}${est.where.toUpperCase()} · ${est.reason}`);
  if (est.method === 'calculation') console.log(`  ${est.gflop} GFLOP · here ~${est.localMinutes} min · Kaggle CPU ~${est.kaggleCpuMinutes} min${est.kaggleGpuMinutes != null ? ` · Kaggle T4 ~${est.kaggleGpuMinutes} min` : ''} · speeds ${est.speeds.measured ? 'measured by ko.py bench' : 'not measured yet (run ko.py bench)'}`);
  else console.log(`  pilot: ${est.items.pilot} of ${est.items.total} items in ${est.pilotSec} s at ${est.cpuPercent}% CPU · here ~${est.localMinutes} min · Kaggle CPU ~${est.kaggleCpuMinutes} min${est.kaggleGpuMinutes != null ? ` · Kaggle T4 ~${est.kaggleGpuMinutes} min` : ''} (+${SETUP_MIN} min setup)`);
  if (est.minutesSaved) console.log(`  time saved: ~${est.minutesSaved} min, and the CPU stays free`);
  if (est.warning) console.log('  ! ' + est.warning);
  if (est.note) console.log('  · ' + est.note);
  console.log('  · times are rough estimates (the GPU ones most of all): the decision is reliable when the gap is large');
}
process.exitCode = over ? 10 : 0;

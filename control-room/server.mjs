// green-compute control room: one page that shows what every skill, agent, model and engine is doing.
// Usage: node server.mjs [port]
// Events come from the plugin's hooks module (POST /event) and are kept in <data dir>/events.jsonl.
// It also reads, without writing: token-diet's plan usage and job grid, kaggle-offload's quota and runs,
// the OpenRouter key's spending (key from OPENROUTER_API_KEY, the plugin's .env or a Windows user variable), and this PC's CPU and memory.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRouterKey } from '../scripts/env.mjs';
import { DATA_DIR, EVENTS, DEFAULT_PORT, TOKEN_DIET_DIR, KAGGLE_DIR, PRICES, family, costOf } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.GREEN_COMPUTE_PORT || DEFAULT_PORT);
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(EVENTS)) fs.writeFileSync(EVENTS, '');

const SKILLS = ['green', 'where-to-run', 'token-diet', 'kaggle-offload', 'or-switch'];
const bare = s => String(s || '').split(':').pop();

// ---------------- state ----------------
let S;
function fresh(title, t0) {
  return {
    run: { title: title || 'green-compute', t0: t0 || Date.now() },
    skills: Object.fromEntries(SKILLS.map(k => [k, { count: 0, last: 0 }])),
    current: null,
    agents: [],
    models: {},          // family -> {tokens, cost, agents, running}
    session: { tokens: 0, cost: 0, turns: 0 },
    openrouter: { runs: 0, active: 0, tokensIn: 0, tokensOut: 0, cost: 0, last: null, switchedTo: null },
    kaggle: { active: 0, runs: 0, last: null },
    log: [],
  };
}
S = fresh();
const ext = { plan: null, planAtStart: null, credit: null, creditAtStart: null, quota: null, kaggleRunning: [], kaggleLast: null, pc: { cpu: 0, mem: 0 }, jobs: null };

function modelRow(f) { return S.models[f] ??= { tokens: 0, cost: 0, agents: 0, running: 0 }; }
function logLine(ev) {
  S.log.push(ev);
  if (S.log.length > 300) S.log.shift();
}

function apply(ev) {
  const t = Date.parse(ev.t) || Date.now();
  if (ev.type === 'run') { S = fresh(ev.title, t); ext.planAtStart = ext.plan; ext.creditAtStart = ext.credit; logLine(ev); return; }
  logLine(ev);
  if (ev.type === 'skill') {
    const k = bare(ev.skill);
    if (!S.skills[k]) S.skills[k] = { count: 0, last: 0, other: true };
    S.skills[k].count++; S.skills[k].last = t; S.current = k;
  } else if (ev.type === 'agent-start') {
    const f = family(ev.model);
    S.agents.push({ id: ev.agentId, description: ev.description || ev.subagentType || 'agent', type: ev.subagentType, model: ev.model, family: f,
      skill: bare(ev.skill) || S.current, start: t, end: null, status: 'running', tokens: 0, cost: 0 });
    const m = modelRow(f); m.agents++; m.running++;
    if (S.current && S.skills[S.current]) S.skills[S.current].last = t;
  } else if (ev.type === 'agent-end') {
    const a = S.agents.find(x => x.id === ev.agentId);
    if (a && a.status === 'running') { a.status = ev.status || 'completed'; a.end = t; modelRow(a.family).running = Math.max(0, modelRow(a.family).running - 1); }
  } else if (ev.type === 'usage') {
    const a = ev.agentId ? S.agents.find(x => x.id === ev.agentId) : null;
    for (const u of ev.usage || []) {
      const f = family(u.model);
      const tok = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      const c = costOf(u, f) || 0;
      const m = modelRow(f); m.tokens += tok; m.cost += c;
      if (a) { a.tokens += tok; a.cost += c; if (!a.family || a.family === 'other') a.family = f; }
      else { S.session.tokens += tok; S.session.cost += c; }
    }
    if (!a) S.session.turns++;
    if (a && a.status === 'running' && ev.final) { a.status = ev.isAborted ? 'stopped' : 'completed'; a.end = t; modelRow(a.family).running = Math.max(0, modelRow(a.family).running - 1); }
  } else if (ev.type === 'engine') {
    const e = ev.engine === 'openrouter' ? S.openrouter : ev.engine === 'kaggle' ? S.kaggle : null;
    if (!e) return;
    if (ev.status === 'start') { e.active++; e.last = { label: ev.label, t }; }
    else { e.active = Math.max(0, e.active - 1); e.runs++; e.last = { label: ev.label, t, status: ev.status };
      if (ev.engine === 'openrouter' && ev.detail) { e.tokensIn += ev.detail.tokensIn || 0; e.tokensOut += ev.detail.tokensOut || 0; e.cost += ev.detail.cost || 0; } }
    const k = ev.engine === 'openrouter' ? 'where-to-run' : 'kaggle-offload';
    if (S.skills[k]) S.skills[k].last = t;
  } else if (ev.type === 'switch') {
    S.openrouter.switchedTo = ev.model === 'claude' ? null : ev.model;
    S.skills['or-switch'].count++; S.skills['or-switch'].last = t; S.current = 'or-switch';
  }
}

// ---------------- external sources ----------------
function lastJsonLine(file) {
  try {
    const st = fs.statSync(file); const n = Math.min(st.size, 4096);
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch {} }
  } catch {}
  return null;
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function pollFiles() {
  const lim = lastJsonLine(join(TOKEN_DIET_DIR, 'limits.jsonl'));
  if (lim) { ext.plan = lim; if (!ext.planAtStart) ext.planAtStart = lim; }
  const q = readJson(join(KAGGLE_DIR, 'quota.json'));
  if (q) ext.quota = q;
  const r = readJson(join(KAGGLE_DIR, 'running.json'));
  ext.kaggleRunning = r ? Object.values(r).map(x => ({ description: x.description, acc: x.acc, since: x.pushed_at })) : [];
  ext.kaggleLast = lastJsonLine(join(KAGGLE_DIR, 'ledger.jsonl'));
  // token-diet's job grid, when token-diet events were written during this run
  try {
    const lines = fs.readFileSync(join(TOKEN_DIET_DIR, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const recent = lines.some(e => (Date.parse(e.t) || 0) >= S.run.t0 - 3600e3);
    ext.jobs = recent ? tokenDietGrid(lines) : null;
  } catch { ext.jobs = null; }
}

// token-diet events (old Italian keys or new ones) -> {title, phases:[{k,model}], jobs:[{name, cells:{phase:state}}]}
function tokenDietGrid(lines) {
  const st = { avvio: 'start', passo: 'step', fine: 'done', errore: 'error' };
  let title = null; const phases = []; const jobs = new Map();
  const ph = (k, m) => { let p = phases.find(x => x.k === k); if (!p) phases.push(p = { k, model: m || 'session' }); else if (m && p.model === 'session') p.model = m; return p; };
  for (const e of lines) {
    const phase = e.phase ?? e.fase;
    if (phase === '_') { title = e.title ?? e.giro ?? title; for (const [k, m] of (e.phases ?? e.fasi ?? [])) ph(k, m === 'sessione' ? 'session' : m); continue; }
    const job = e.job ?? e.materia; if (!job || !phase) continue;
    const status = st[e.status ?? e.stato] || (e.status ?? e.stato);
    ph(phase, e.model ?? e.modello);
    if (!jobs.has(job)) jobs.set(job, {});
    const c = jobs.get(job);
    c[phase] = status === 'start' || status === 'step' ? 'running' : status;
  }
  return { title, phases, jobs: [...jobs].map(([name, cells]) => ({ name, cells })) };
}

const orKey = openRouterKey();
async function pollCredit() {
  if (!orKey) return;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${orKey}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const d = (await r.json()).data;
    ext.credit = { usage: d.usage, limit: d.limit };
    if (!ext.creditAtStart) ext.creditAtStart = ext.credit;
  } catch {}
}

let prevCpu = os.cpus();
function pollPc() {
  const now = os.cpus(); let idle = 0, total = 0;
  now.forEach((c, i) => { const p = prevCpu[i]?.times || c.times; for (const k in c.times) total += c.times[k] - p[k]; idle += c.times.idle - p.idle; });
  prevCpu = now;
  ext.pc = { cpu: total ? Math.round((1 - idle / total) * 100) : 0, mem: Math.round((1 - os.freemem() / os.totalmem()) * 100), cores: now.length };
}

// ---------------- snapshot for the page ----------------
function snapshot() {
  const fams = Object.keys(S.models);
  const claudeCost = fams.filter(f => PRICES[f]).reduce((s, f) => s + S.models[f].cost, 0);
  const claudeTokens = fams.filter(f => PRICES[f]).reduce((s, f) => s + S.models[f].tokens, 0);
  // "all on Opus": every Claude token at Opus's ratio of its own family's cost, plus OpenRouter tokens at Opus prices
  const opusRatio = f => PRICES.opus[0] / PRICES[f][0];
  const allOpus = fams.filter(f => PRICES[f]).reduce((s, f) => s + S.models[f].cost * opusRatio(f), 0)
    + (S.openrouter.tokensIn * PRICES.opus[0] + S.openrouter.tokensOut * PRICES.opus[1]) / 1e6;
  const measured = claudeCost + S.openrouter.cost;
  return {
    now: Date.now(), run: S.run, current: S.current, skills: S.skills,
    agents: S.agents.slice(-40), models: S.models, session: S.session,
    openrouter: { ...S.openrouter, credit: ext.credit, creditAtStart: ext.creditAtStart, hasKey: !!orKey },
    kaggle: { ...S.kaggle, quota: ext.quota, running: ext.kaggleRunning, lastRun: ext.kaggleLast },
    pc: ext.pc, plan: ext.plan, planAtStart: ext.planAtStart, jobs: ext.jobs,
    totals: { claudeTokens, claudeCost, measured, allOpus, saved: allOpus > 0 ? 1 - measured / allOpus : 0 },
  };
}

// ---------------- events file ----------------
let readPos = 0, tail = '';
function pollEvents() {
  let st; try { st = fs.statSync(EVENTS); } catch { return; }
  if (st.size < readPos) { readPos = 0; tail = ''; S = fresh(); }
  if (st.size === readPos) return;
  const fd = fs.openSync(EVENTS, 'r'); const buf = Buffer.alloc(st.size - readPos);
  fs.readSync(fd, buf, 0, buf.length, readPos); fs.closeSync(fd); readPos = st.size;
  const parts = (tail + buf.toString('utf8')).split('\n'); tail = parts.pop();
  for (const p of parts) { try { apply(JSON.parse(p)); } catch {} }
  dirty = true;
}

// ---------------- server ----------------
const clients = new Set();
let dirty = true;
function push() {
  if (!clients.size || !dirty) return;
  dirty = false;
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) c.write(data);
}

http.createServer((req, res) => {
  const url = req.url || '/';
  if (req.method === 'POST' && url.startsWith('/event')) {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body); ev.t ??= new Date().toISOString();
        fs.appendFileSync(EVENTS, JSON.stringify(ev) + '\n');
        pollEvents(); push();
        res.end('ok');
      } catch { res.statusCode = 400; res.end('bad event'); }
    });
    return;
  }
  if (url.startsWith('/stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`event: log\ndata: ${JSON.stringify(S.log)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (url.startsWith('/log')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(S.log)); return; }
  if (url.startsWith('/health')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, app: 'green-compute', pid: process.pid, events: EVENTS })); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(join(HERE, 'index.html')));
}).listen(PORT, '127.0.0.1', () => console.log(`green-compute control room: http://localhost:${PORT}`));

pollEvents(); pollFiles(); pollPc(); pollCredit();
setInterval(pollEvents, 500);
setInterval(() => { pollFiles(); pollPc(); dirty = true; }, 2000);
setInterval(pollCredit, 60000);
setInterval(() => { dirty = true; push(); }, 1000); // timers on the page move every second

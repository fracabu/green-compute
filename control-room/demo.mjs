// Demo of the control room with made-up data, for screenshots and for trying it out.
// Usage: node demo.mjs [--port 4791] [--no-open]
// Everything goes to a throw-away folder (<tmp>/green-compute-demo): your real data is never read or touched.
import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 4791;
const root = join(os.tmpdir(), 'green-compute-demo');
fs.rmSync(root, { recursive: true, force: true });
const home = join(root, 'gc'), td = join(root, 'td'), kg = join(root, 'kg');
for (const d of [home, td, kg]) fs.mkdirSync(d, { recursive: true });

const iso = ms => new Date(ms).toISOString();
const now = Date.now();
const h5r = Math.floor((now + 3 * 3600e3) / 1000), d7r = Math.floor((now + 4 * 86400e3) / 1000);
fs.writeFileSync(join(td, 'limits.jsonl'), JSON.stringify({ t: iso(now - 60e3), h5: 18, h5r, d7: 44, d7r }) + '\n');
fs.writeFileSync(join(kg, 'quota.json'), JSON.stringify({ gpu: { used: 6.4, remaining: 23.6, total: 30 }, tpu: { used: 0, remaining: 20, total: 20 } }));
fs.writeFileSync(join(kg, 'running.json'), '{}');

const env = { ...process.env, GREEN_COMPUTE_HOME: home, TOKEN_DIET_HOME: td, KAGGLE_OFFLOAD_HOME: kg, OPENROUTER_API_KEY: '' };
const srv = spawn(process.execPath, [join(HERE, 'server.mjs'), String(port)], { stdio: 'inherit', env });
const url = `http://localhost:${port}`;
const post = ev => fetch(url + '/event', { method: 'POST', body: JSON.stringify(ev) }).catch(() => {});
const tdEvent = ev => fs.appendFileSync(join(td, 'events.jsonl'), JSON.stringify({ t: iso(Date.now()), ...ev }) + '\n');

const u = (model, input, output, cacheRead = 0) => [{ model, input, output, cacheRead, cacheWrite: 0 }];
const chapters = ['01-install', '02-quickstart', '03-config', '04-api', '05-errors'];
const plan = [
  [300, () => post({ type: 'run', title: 'docs rewrite · 5 chapters + 2,000 translations + 3 h of audio' })],
  [600, () => post({ type: 'skill', skill: 'green-compute:green' })],
  [1200, () => post({ type: 'skill', skill: 'green-compute:where-to-run' })],
  [1600, () => post({ type: 'usage', usage: u('claude-opus-5-5', 4000, 1800, 60000), durationMs: 41000 })],
  [2000, () => { post({ type: 'skill', skill: 'token-diet:token-diet' }); tdEvent({ phase: '_', title: 'docs rewrite', phases: [['scan', 'haiku'], ['write', 'sonnet'], ['verify', 'opus']] }); }],
];
let t = 2600;
chapters.forEach((c, i) => {
  const s0 = t + i * 700, w0 = s0 + 3200 + i * 900, v0 = w0 + 7000 + i * 600;
  plan.push([s0, () => { post({ type: 'agent-start', agentId: `scan-${i}`, description: `scan ${c}`, model: 'claude-haiku-5-5', skill: 'token-diet' }); tdEvent({ job: c, phase: 'scan', status: 'start', model: 'haiku' }); }]);
  plan.push([s0 + 2600, () => { post({ type: 'usage', agentId: `scan-${i}`, usage: u('claude-haiku-5-5', 70000 + i * 9000, 6000), final: true }); tdEvent({ job: c, phase: 'scan', status: 'done', model: 'haiku' }); }]);
  plan.push([w0, () => { post({ type: 'agent-start', agentId: `write-${i}`, description: `write ${c}`, model: 'claude-sonnet-5-5', skill: 'token-diet' }); tdEvent({ job: c, phase: 'write', status: 'start', model: 'sonnet' }); }]);
  if (i < 4) plan.push([w0 + 6000, () => { post({ type: 'usage', agentId: `write-${i}`, usage: u('claude-sonnet-5-5', 150000 + i * 12000, 24000), final: true }); tdEvent({ job: c, phase: 'write', status: 'done', model: 'sonnet' }); }]);
  if (i < 3) {
    plan.push([v0, () => { post({ type: 'agent-start', agentId: `verify-${i}`, description: `verify ${c}`, model: 'claude-opus-5-5', skill: 'token-diet' }); tdEvent({ job: c, phase: 'verify', status: 'start', model: 'opus' }); }]);
    if (i < 1) plan.push([v0 + 5000, () => { post({ type: 'usage', agentId: `verify-${i}`, usage: u('claude-opus-5-5', 120000, 14000), final: true }); tdEvent({ job: c, phase: 'verify', status: 'done', model: 'opus' }); }]);
  }
});
plan.push([5200, () => post({ type: 'engine', engine: 'openrouter', status: 'start', label: 'or-batch · deepseek/deepseek-v4.1-flash · 2,000 translations' })]);
plan.push([15000, () => post({ type: 'engine', engine: 'openrouter', status: 'done', label: 'or-batch · deepseek/deepseek-v4.1-flash', detail: { tokensIn: 410000, tokensOut: 380000, cost: 0.1 } })]);
plan.push([6200, () => { post({ type: 'skill', skill: 'kaggle-offload' }); post({ type: 'engine', engine: 'kaggle', status: 'start', label: 'whisper large-v3 · 3 h of audio' }); fs.writeFileSync(join(kg, 'running.json'), JSON.stringify({ r1: { description: 'whisper large-v3 · 3 h of audio', acc: 'gpu', pushed_at: iso(Date.now()) } })); }]);
plan.push([9000, () => fs.appendFileSync(join(td, 'limits.jsonl'), JSON.stringify({ t: iso(Date.now()), h5: 31, h5r, d7: 46.5, d7r }) + '\n')]);

for (const [dt, fn] of plan) setTimeout(fn, dt);
if (!args.includes('--no-open')) setTimeout(() => exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`), 500);
console.log(`[demo] ${url}  (data: ${root}) · ~20 s of made-up work, the server stays up: Ctrl+C to stop`);
process.on('SIGINT', () => { srv.kill(); process.exit(0); });

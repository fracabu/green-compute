// Run a batch of text prompts on an OpenRouter model, without moving the Claude Code session.
// Usage: node or-batch.mjs --model <id> --in jobs.jsonl --out results.jsonl [--system "..."] [--concurrency 4]
//                          [--max-tokens 2000] [--temperature 0.2] [--base-url https://openrouter.ai/api/v1]
// jobs.jsonl: one JSON object per line, {"id": "...", "prompt": "..."} (an optional "system" overrides --system).
// results.jsonl: {"id", "model", "output", "tokens_in", "tokens_out", "cost", "sec"} or {"id", "error"}.
// Lines already in results.jsonl with an output are skipped, so a stopped run resumes where it left off.
// Needs OPENROUTER_API_KEY in the environment. On Windows a key stored with setx is also read from the registry.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const model = opt('model');
const input = opt('in');
const output = opt('out', 'results.jsonl');
const system = opt('system');
const concurrency = Math.max(1, Number(opt('concurrency', 4)));
const maxTokens = Number(opt('max-tokens', 2000));
const temperature = Number(opt('temperature', 0.2));
const baseUrl = opt('base-url', 'https://openrouter.ai/api/v1').replace(/\/$/, '');
if (!model || !input) {
  console.error('usage: node or-batch.mjs --model <openrouter-id> --in jobs.jsonl --out results.jsonl [--system "..."] [--concurrency 4]');
  process.exit(1);
}

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (process.platform === 'win32') {
    try {
      const out = execSync('reg query HKCU\\Environment /v OPENROUTER_API_KEY', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/OPENROUTER_API_KEY\s+REG_\w+\s+(\S+)/);
      if (m) return m[1];
    } catch {}
  }
  return null;
}
const key = apiKey();
if (!key) { console.error('OPENROUTER_API_KEY is not set (setx OPENROUTER_API_KEY "sk-or-v1-..." on Windows, export elsewhere)'); process.exit(1); }

const jobs = fs.readFileSync(input, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map((l, i) => {
  try { return JSON.parse(l); } catch { console.error(`line ${i + 1} of ${input} is not JSON: skipped`); return null; }
}).filter(j => j && j.id != null && typeof j.prompt === 'string');

const done = new Set();
if (fs.existsSync(output)) {
  for (const l of fs.readFileSync(output, 'utf8').split('\n')) {
    try { const r = JSON.parse(l); if (r.output != null) done.add(String(r.id)); } catch {}
  }
}
const todo = jobs.filter(j => !done.has(String(j.id)));
console.log(`${jobs.length} jobs, ${done.size} already done, ${todo.length} to run on ${model}`);

async function call(job, attempt = 1) {
  const t0 = Date.now();
  const messages = [];
  const sys = job.system ?? system;
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: job.prompt });
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'green-compute' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, usage: { include: true } }),
    signal: AbortSignal.timeout(300000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise(r => setTimeout(r, 2000 * attempt * attempt));
    return call(job, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error?.message || `HTTP ${res.status}`);
  const u = body.usage || {};
  return {
    id: job.id, model: body.model || model,
    output: body.choices?.[0]?.message?.content ?? '',
    tokens_in: u.prompt_tokens ?? null, tokens_out: u.completion_tokens ?? null,
    cost: u.cost ?? null, sec: +((Date.now() - t0) / 1000).toFixed(1),
  };
}

let next = 0, ok = 0, failed = 0, cost = 0, tin = 0, tout = 0;
async function worker() {
  while (next < todo.length) {
    const job = todo[next++];
    let row;
    try { row = await call(job); ok++; cost += row.cost || 0; tin += row.tokens_in || 0; tout += row.tokens_out || 0; }
    catch (e) { row = { id: job.id, error: String(e.message || e) }; failed++; }
    fs.appendFileSync(output, JSON.stringify(row) + '\n');
    process.stdout.write(`\r${ok + failed}/${todo.length} done, ${failed} failed`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
console.log(`\n${ok} ok, ${failed} failed · ${tin} tokens in, ${tout} out · cost reported by OpenRouter: $${cost.toFixed(4)} · ${output}`);
process.exit(failed ? 2 : 0);

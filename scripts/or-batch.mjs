// Run a batch of text prompts on an OpenRouter model, without moving the Claude Code session.
// Usage: node or-batch.mjs --model <id> --in jobs.jsonl --out results.jsonl [--system "..."] [--concurrency 4]
//                          [--max-tokens 2000] [--temperature 0.2] [--reasoning none|low|medium|high]
//                          [--base-url https://openrouter.ai/api/v1]
// jobs.jsonl: one JSON object per line, {"id": "...", "prompt": "..."} (an optional "system" overrides --system).
// results.jsonl: {"id", "model", "output", "tokens_in", "tokens_out", "reasoning_tokens", "cost", "sec"} or {"id", "error"}.
// Lines already in results.jsonl with an output are skipped, so a stopped run resumes where it left off.
// --reasoning: many recent models think before answering, and those tokens count against --max-tokens
// and are billed. For simple tasks (translate, classify, extract) "none" or "low" is cheaper; some models
// refuse "none". An empty answer is recorded as an error, so the next run retries it.
// Needs an OpenRouter key: OPENROUTER_API_KEY, the plugin's .env file, or (Windows) a setx user variable.
import fs from 'node:fs';
import { openRouterKey } from './env.mjs';

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
const reasoningArg = opt('reasoning');
const reasoning = reasoningArg === undefined ? undefined
  : reasoningArg === 'none' ? { enabled: false } : { effort: reasoningArg };
if (!model || !input) {
  console.error('usage: node or-batch.mjs --model <openrouter-id> --in jobs.jsonl --out results.jsonl [--system "..."] [--concurrency 4]');
  process.exit(1);
}

const key = openRouterKey();
if (!key) { console.error('No OpenRouter key: set OPENROUTER_API_KEY, or copy .env.example to .env in the plugin folder and fill it in'); process.exit(1); }

const jobs = fs.readFileSync(input, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map((l, i) => {
  try { return JSON.parse(l); } catch { console.error(`line ${i + 1} of ${input} is not JSON: skipped`); return null; }
}).filter(j => j && j.id != null && typeof j.prompt === 'string');

const done = new Set();
if (fs.existsSync(output)) {
  for (const l of fs.readFileSync(output, 'utf8').split('\n')) {
    try { const r = JSON.parse(l); if (r.output) done.add(String(r.id)); } catch {}
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
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, usage: { include: true }, ...(reasoning && { reasoning }) }),
    signal: AbortSignal.timeout(300000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise(r => setTimeout(r, 2000 * attempt * attempt));
    return call(job, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error?.message || `HTTP ${res.status}`);
  const u = body.usage || {};
  const choice = body.choices?.[0] || {};
  const text = (choice.message?.content ?? '').trim();
  const row = {
    id: job.id, model: body.model || model,
    tokens_in: u.prompt_tokens ?? null, tokens_out: u.completion_tokens ?? null,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? null,
    cost: u.cost ?? null, sec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  // An empty answer is a failure, not a result: usually the reasoning used up max_tokens.
  if (!text) {
    row.error = choice.finish_reason === 'length'
      ? `empty answer: max_tokens (${maxTokens}) used up, probably by reasoning; raise --max-tokens or use --reasoning low/none`
      : `empty answer (finish_reason: ${choice.finish_reason ?? 'unknown'})`;
    return row;
  }
  return { ...row, output: text };
}

let next = 0, ok = 0, failed = 0, cost = 0, tin = 0, tout = 0, treason = 0;
async function worker() {
  while (next < todo.length) {
    const job = todo[next++];
    let row;
    try {
      row = await call(job);
      // billed even when the answer came back empty
      cost += row.cost || 0; tin += row.tokens_in || 0; tout += row.tokens_out || 0; treason += row.reasoning_tokens || 0;
      if (row.error) failed++; else ok++;
    } catch (e) { row = { id: job.id, error: String(e.message || e) }; failed++; }
    fs.appendFileSync(output, JSON.stringify(row) + '\n');
    process.stdout.write(`\r${ok + failed}/${todo.length} done, ${failed} failed`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
console.log(`\n${ok} ok, ${failed} failed · ${tin} tokens in, ${tout} out (${treason} of them reasoning) · cost reported by OpenRouter: $${cost.toFixed(6)} · ${output}`);
process.exitCode = failed ? 2 : 0;

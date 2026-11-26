// Live list of OpenRouter models with tool calling, newest first, with prices per million tokens.
// Usage: node or-models.mjs [--group chinese|gemini|free|others|all] [--top 3] [--json]
// Default group: chinese (DeepSeek, Kimi, Qwen, GLM), the newest --top models of each lab.
// Prices come from OpenRouter's public model list at the moment you run it: never quote them from memory.
const GROUPS = {
  chinese: ['deepseek/', 'moonshotai/', 'qwen/', 'z-ai/'],
  gemini: ['google/gemini'],
  others: ['x-ai/', 'openai/', 'minimax/', 'mistralai/'],
  free: [''],
  all: [''],
};
// Claude API prices per million tokens [input, output], for comparison (checked 26/11/2026).
const CLAUDE = { haiku: [0.10, 0.50], sonnet: [2, 10], opus: [4, 20] };

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const group = opt('group', 'chinese');
const top = Number(opt('top', 3));
const asJson = args.includes('--json');
if (!GROUPS[group]) { console.error(`unknown group "${group}": ${Object.keys(GROUPS).join(', ')}`); process.exit(1); }

const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20000) });
if (!res.ok) { console.error(`OpenRouter answered ${res.status}`); process.exit(1); }
const all = (await res.json()).data
  .filter(m => (m.supported_parameters || []).includes('tools'))
  .filter(m => !m.id.endsWith(':batch'))
  .filter(m => (group === 'free') === m.id.endsWith(':free'))
  .filter(m => !(group === 'gemini' && /banana|image/.test(m.id)))
  .sort((a, b) => b.created - a.created);

const picked = [];
for (const p of GROUPS[group]) picked.push(...all.filter(m => m.id.startsWith(p)).slice(0, group === 'all' ? 40 : top));
const perM = x => Number(x) * 1e6;
const rows = picked.map(m => ({
  id: m.id,
  released: new Date(m.created * 1000).toISOString().slice(0, 10),
  input: +perM(m.pricing.prompt).toFixed(2),
  output: +perM(m.pricing.completion).toFixed(2),
  blended: +(0.85 * perM(m.pricing.prompt) + 0.15 * perM(m.pricing.completion)).toFixed(2),
  context: m.context_length,
}));

if (asJson) { console.log(JSON.stringify({ checked: new Date().toISOString(), group, models: rows, claude: CLAUDE }, null, 2)); process.exit(0); }
const pad = (s, n) => String(s).padEnd(n);
console.log(`OpenRouter, group "${group}", tool calling only, checked ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
console.log(pad('model', 40) + pad('released', 12) + pad('$ in/M', 9) + pad('$ out/M', 9) + pad('blend*', 8) + 'context');
for (const r of rows) console.log(pad(r.id, 40) + pad(r.released, 12) + pad(r.input, 9) + pad(r.output, 9) + pad(r.blended, 8) + r.context);
console.log('\n* blend = 85% input + 15% output, the same mix token-diet uses. For comparison, Claude: ' +
  Object.entries(CLAUDE).map(([k, [i, o]]) => `${k} ${(0.85 * i + 0.15 * o).toFixed(2)}`).join(', ') + ' (checked 26/11/2026).');

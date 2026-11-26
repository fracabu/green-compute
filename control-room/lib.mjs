// Shared bits for the green-compute control room: data dir, port, prices, model families.
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DATA_DIR = process.env.GREEN_COMPUTE_HOME
  ? resolve(process.env.GREEN_COMPUTE_HOME)
  : join(os.homedir(), '.green-compute');
export const EVENTS = join(DATA_DIR, 'events.jsonl');
export const LOG = join(DATA_DIR, 'server.log');
export const DEFAULT_PORT = 4790;

// Where the other tools keep their data (each can be moved with its own variable).
export const TOKEN_DIET_DIR = process.env.TOKEN_DIET_HOME ? resolve(process.env.TOKEN_DIET_HOME) : join(os.homedir(), '.token-diet');
export const KAGGLE_DIR = process.env.KAGGLE_OFFLOAD_HOME ? resolve(process.env.KAGGLE_OFFLOAD_HOME) : join(os.homedir(), '.kaggle-offload');

// The CPU rule: a job that would keep this PC's CPU at or above cpuMaxPercent for cpuMaxMinutes or more
// goes to Kaggle instead (GPU for model work, CPU-only sessions for the rest). Change it in
// <data dir>/config.json, e.g. {"cpuMaxPercent": 60, "cpuMaxMinutes": 10}.
export const CONFIG_FILE = join(DATA_DIR, 'config.json');
export const CONFIG_DEFAULTS = { cpuMaxPercent: 50, cpuMaxMinutes: 5 };
export function readConfig() {
  try { return { ...CONFIG_DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }; } catch { return { ...CONFIG_DEFAULTS }; }
}

// Claude API prices per million tokens [input, output] (checked 26/11/2026).
// Cache reads cost 0.1x input, cache writes 1.25x input.
export const PRICES = { haiku: [0.10, 0.50], sonnet: [2, 10], opus: [4, 20], fable: [8, 40] };

// Model id or alias -> family: haiku | sonnet | opus | fable | other.
export function family(model = '') {
  const m = String(model).toLowerCase();
  for (const f of Object.keys(PRICES)) if (m.includes(f)) return f;
  return 'other';
}

// Dollar cost of one usage record at API prices; null for non-Claude models.
export function costOf(u, fam = family(u.model)) {
  const p = PRICES[fam];
  if (!p) return null;
  const [i, o] = p.map(x => x / 1e6);
  return (u.input || 0) * i + (u.output || 0) * o + (u.cacheRead || 0) * i * 0.1 + (u.cacheWrite || 0) * i * 1.25;
}

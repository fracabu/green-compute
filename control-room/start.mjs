// Start the green-compute control room (if it isn't running) and open it in the browser.
// Usage: node start.mjs [--title "what this run is about"] [--no-open] [--port 4790]
//   --title  starts a new run: counters, agents and costs start from zero under that title
import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, LOG, DEFAULT_PORT } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
const port = Number(opt('port') || process.env.GREEN_COMPUTE_PORT || DEFAULT_PORT);
const url = `http://localhost:${port}`;
const title = opt('title');

async function health() {
  try {
    const r = await fetch(url + '/health', { signal: AbortSignal.timeout(800) });
    const j = r.ok ? await r.json() : null;
    return j && j.app === 'green-compute' ? j : null;
  } catch { return null; }
}

let started = false;
if (!(await health())) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(LOG, 'a');
  const p = spawn(process.execPath, [join(HERE, 'server.mjs'), String(port)], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env });
  p.unref();
  started = true;
  for (let i = 0; i < 30 && !(await health()); i++) await new Promise(r => setTimeout(r, 150));
}
if (!(await health())) { console.error(`[!] the control room did not start: see ${LOG}`); process.exitCode = 1; }
else {
  if (title) await fetch(url + '/event', { method: 'POST', body: JSON.stringify({ type: 'run', title }) }).catch(() => {});
  if (!args.includes('--no-open')) exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
  console.log(`[OK] control room ${started ? 'started' : 'already running'}: ${url}${title ? `  (new run: ${title})` : ''}`);
}

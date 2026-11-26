// Finds the OpenRouter key: the OPENROUTER_API_KEY environment variable, then the plugin's own .env file
// (git-ignored; copy .env.example), then, on Windows, a user variable stored with setx (the registry).
// The key is returned, never printed.
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function openRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  // an empty variable means "no key on purpose" (the demo sets it so)
  if ('OPENROUTER_API_KEY' in process.env) return null;
  try {
    const m = fs.readFileSync(join(ROOT, '.env'), 'utf8').match(/^\s*OPENROUTER_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
    if (m) return m[1];
  } catch {}
  if (process.platform === 'win32') {
    try {
      const out = execSync('reg query HKCU\\Environment /v OPENROUTER_API_KEY', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/OPENROUTER_API_KEY\s+REG_\w+\s+(\S+)/);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

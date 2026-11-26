import type { EngineInterface, Register } from 'claude-code'

// Feeds the green-compute control room (control-room/server.mjs) with what happens in this session:
// which skill is working, the sub-agents it starts and on which model, the tokens of every turn,
// and the batches sent to OpenRouter or Kaggle. Nothing is recorded until one of green-compute's
// skills runs in this session; then the control room is started (and opened) if it isn't running.

const PORT = 4790
const BASE = `http://127.0.0.1:${PORT}`
const OURS = new Set(['green', 'where-to-run', 'token-diet', 'kaggle-offload'])
const bare = (s: string) => s.split(':').pop() ?? s

let active = false
let skill: string | null = null

async function post($: EngineInterface, ev: Record<string, unknown>) {
  try {
    await $.http.fetch(`${BASE}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: new Date().toISOString(), session: await $.session.id(), ...ev }),
    })
  } catch {
    // the control room is closed: nothing to show it to
  }
}

async function isUp($: EngineInterface): Promise<boolean> {
  try {
    const r = await $.http.fetch(`${BASE}/health`)
    return r.ok && r.text.includes('green-compute')
  } catch {
    return false
  }
}

// Starts the control room and opens it, unless it is already running.
async function ensureRoom($: EngineInterface) {
  if (await isUp($)) return
  await $.process.run(['node', `${$.plugin.root}/control-room/start.mjs`], { timeoutMs: 15000 }).catch(() => undefined)
}

// Which engine a shell command sends work to, if any.
function engineOf(cmd: string): { engine: 'openrouter' | 'kaggle'; label: string } | null {
  if (/or-batch\.mjs/.test(cmd)) {
    const model = cmd.match(/--model\s+("?)([^\s"]+)\1/)?.[2] ?? 'model'
    return { engine: 'openrouter', label: `or-batch · ${model}` }
  }
  if (/ko\.py["']?\s+(run|queue\s+launch|bench|cache)\b/.test(cmd)) {
    const what = cmd.match(/--template\s+(\S+)/)?.[1] ?? cmd.match(/ko\.py["']?\s+(\S+(\s+\S+)?)/)?.[1] ?? 'job'
    return { engine: 'kaggle', label: `kaggle-offload · ${what}` }
  }
  return null
}

// or-batch prints "N ok, M failed · X tokens in, Y out (...) · cost reported by OpenRouter: $Z"
function orDetail(text: string) {
  const tin = Number(text.match(/(\d+) tokens in/)?.[1] ?? 0)
  const tout = Number(text.match(/tokens in, (\d+) out/)?.[1] ?? 0)
  const cost = Number(text.match(/cost reported by OpenRouter: \$([\d.]+)/)?.[1] ?? 0)
  return { tokensIn: tin, tokensOut: tout, cost }
}

export const register: Register = (on) => {
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    const name = bare(e.skill)
    if (OURS.has(name)) {
      skill = name
      if (!active) {
        active = true
        // /green starts the room itself, with the run's title
        if (name !== 'green') await ensureRoom($)
      }
      void post($, { type: 'skill', skill: name })
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (active && 'agentId' in result && result.agentId) {
      void post($, {
        type: 'agent-start', agentId: result.agentId, description: e.description,
        subagentType: e.subagentType, model: result.model, skill,
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('agent.report', async ($, e, next) => {
    const result = await next(e)
    if (active) void post($, { type: 'agent-end', agentId: e.agentId, status: e.status })
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (active && e.usage) {
      const u = e.usage
      void post($, {
        type: 'usage', agentId: e.agentId ?? null, durationMs: e.durationMs, isAborted: e.isAborted, final: !!e.agentId,
        usage: [{
          model: u.model, input: u.input_tokens, output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
        }],
      })
    }
    return result
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const eng = active ? engineOf(e.command) : null
    if (!eng) return next(e)
    void post($, { type: 'engine', engine: eng.engine, status: 'start', label: eng.label })
    const ran = await next(e)
    const text = ran.text ?? ''
    const failed = ran.deny !== undefined || ran.isError === true
    void post($, {
      type: 'engine', engine: eng.engine, status: failed ? 'error' : 'done', label: eng.label,
      detail: eng.engine === 'openrouter' ? orDetail(text) : undefined,
    })
    return ran
  }).catch(($, e, next) => next(e))
}

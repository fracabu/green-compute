import type { EngineInterface, Register } from 'claude-code'

// Feeds the green-compute control room (control-room/server.mjs) with what happens, live: which skill
// is working, the sub-agents it starts and on which model, every action of the session and of each
// agent (the file it reads, the command it runs...), the tokens of every turn, and the batches sent to
// OpenRouter or Kaggle. A session reports once one of green-compute's skills runs in it (which also
// starts and opens the room), or as soon as it finds the room already open.

const PORT = 4790
const BASE = `http://127.0.0.1:${PORT}`
const OURS = new Set(['green', 'where-to-run', 'token-diet', 'kaggle-offload'])
const bare = (s: string) => s.split(':').pop() ?? s

let active = false
let skill: string | null = null
let sessionId: string | null = null
let project: string | null = null
let lastCheck = 0

async function post($: EngineInterface, ev: Record<string, unknown>) {
  try {
    sessionId ??= await $.session.id()
    if (project === null) {
      const root = await $.session.root().catch(() => '')
      project = root.split(/[\\/]/).filter(Boolean).pop() ?? ''
    }
    await $.http.fetch(`${BASE}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: new Date().toISOString(), session: sessionId, project, ...ev }),
    })
  } catch {
    // the control room is closed: nothing to show it to
  }
}

// A session that hasn't run our skills still reports while the room is open (checked at most every 20 s).
async function activateIfRoomOpen($: EngineInterface) {
  if (active || Date.now() - lastCheck < 20000) return
  lastCheck = Date.now()
  if (await isUp($)) active = true
}

// One short line saying what a tool call does: "Read server.mjs", "Bash npm test", "Grep fetch".
function summary(e: Record<string, unknown>): string {
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const file = (p: string) => p.split(/[\\/]/).pop() ?? p
  const cut = (t: string, n = 70) => (t.length > n ? t.slice(0, n - 1) + '…' : t).replace(/\s+/g, ' ')
  const tool = s('tool')
  switch (tool) {
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return `${tool} ${file(s('file_path') || s('notebook_path'))}`
    case 'Bash': case 'PowerShell': return `${tool === 'Bash' ? '$' : 'PS'} ${cut(s('command'))}`
    case 'Grep': return `Grep "${cut(s('pattern'), 40)}"`
    case 'Glob': return `Glob ${cut(s('pattern'), 50)}`
    case 'WebSearch': return `Search "${cut(s('query'), 50)}"`
    case 'WebFetch': return `Fetch ${cut(s('url'), 60)}`
    case 'Agent': return `Agent: ${cut(s('description'), 50)}`
    case 'Skill': return `Skill ${s('skill')}`
    default: return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool
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

  on('turn.start', async ($, e, next) => {
    await activateIfRoomOpen($)
    if (active) void post($, { type: 'turn-start', agentId: e.agentId ?? null, skill })
    return next(e)
  }).catch(($, e, next) => next(e))

  // every action, of the session and of each agent, as it starts and as it ends
  on('tool.call', async ($, e, next) => {
    // internal plumbing, not work anyone needs to watch
    if (!active || (e.tool as string) === 'SubagentHandback') return next(e)
    const what = summary(e as unknown as Record<string, unknown>)
    void post($, { type: 'act', agentId: e.agentId ?? null, tool: e.tool, summary: what, skill })
    const ran = await next(e)
    const failed = ran.deny !== undefined || ran.isError === true
    void post($, { type: 'act-end', agentId: e.agentId ?? null, tool: e.tool, summary: what, ok: !failed })
    return ran
  }).catch(($, e, next) => next(e))

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

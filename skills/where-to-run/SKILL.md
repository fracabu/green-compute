---
name: where-to-run
description: >-
  Decides where a job should run to spend the least for the same result: on Claude (then token-diet
  picks the model and effort per phase), on a cheap open model through OpenRouter (Chinese labs such as
  DeepSeek, Qwen, Kimi, GLM), on Kaggle's free GPUs (kaggle-offload, which also keeps the PC's CPU free)
  or on the PC itself. Checks the cost of an error, where the data may go, whether a GPU is needed and
  live prices, and proposes a small pilot before any bulk run on an open model. Use it before batch work
  on many items (translate, classify, summarise, extract, transcribe, generate), when the plan's weekly
  limit is running out, or when the user asks which model or machine to use or how to spend less.
when_to_use: >-
  "where should this run?", "is there a cheaper model for this?", "can DeepSeek/Qwen/Kimi do this?",
  "I'm out of Claude for the week", "keep my CPU free", "use OpenRouter", "batch this on an open
  model"; in Italian: "dove lo faccio girare?", "c'è un modello che costa meno?", "lo può fare
  DeepSeek/Qwen/Kimi?", "ho finito la settimana di Claude", "tieni libera la CPU", "usa OpenRouter",
  "fallo con un modello open"; or before a job that repeats the same text task on dozens of items.
---

# where-to-run

The goal is the **cost per finished job**: money, plan quota and the PC's own CPU time, for a result
that is as good as it needs to be. A cheap engine that gets it wrong and has to be redone, or lets an
error out, is the expensive one.

Below, `GC/<file>` stands for `node "${CLAUDE_PLUGIN_ROOT}/scripts/<file>"`. The other skills named here
(`token-diet`, `kaggle-offload`) and the `/or` and `/claude` commands come with this plugin.

## The four places

| Where | Good for | Costs | Watch out |
|---|---|---|---|
| **Claude** (your plan or the API) | judgement, verification, agentic coding, anything that ships to clients or the public, long tool-using sessions | plan quota or API tokens | step down per phase with **token-diet** |
| **Open model on OpenRouter** | bulk text work with clear rules and a cheap error: translate, classify, summarise, extract, rewrite to a template, first drafts that get checked | pay per token: on 27/11/2026 from about 3× (large models) to about 90× (flash models) cheaper than Opus; check live | data goes to a third party; quality varies by model and task: pilot first |
| **Kaggle GPU** (**kaggle-offload**) | open-weight models that need a GPU: speech to text, text to speech, images, video, fine-tuning, an open LLM on many items | free, about 30 GPU hours a week | data goes to Kaggle (Google); setup takes minutes, so batch |
| **This PC** | light work, small models that run fast on its CPU, anything private | the PC's CPU and your time | a long CPU job blocks the machine: offload it |

## Procedure

### 1. Where may the data go?

Personal data, client material, anything confidential → **no new third party**: Claude (already in
use) or this PC only. Never OpenRouter or Kaggle. Ask if unsure; don't guess.

### 2. What does an error cost?

Reaches clients, the public, money or production → **Claude**, with the verification phase on a
strong model (token-diet). Caught by a later check, or cheap to redo → an open model may do it.

### 3. Will it load this PC? Estimate first, then decide

Any job that computes locally (a model, a conversion, a long script) is **estimated before it runs**:

- size known → `GC/estimate.mjs --params-b <B> --tokens <N>` (transformer inference) or `--gflop <G>`;
- size unknown → a pilot on a few items: `GC/estimate.mjs --pilot "<the real command on 1-5 items>" --items-pilot <n> --items-total <N>`.
  Add `--cpu-only` when the job can't use a GPU, and `--label "<what>"` for the control room.

It applies two rules, and either one sends the job to Kaggle:

- **CPU**: the job would keep the CPU at or above the limit (default 50%) for the limit's minutes or more (default 5);
- **time**: the job is longer than those minutes, and on Kaggle, with about 3 minutes of setup, it would take less than half.

When it answers `KAGGLE-GPU` or `KAGGLE-CPU` (exit code 10), **go there directly, without asking**: hand
the job to **kaggle-offload** (GPU for model work; a CPU-only session, which uses no quota, for the rest).
The PC stays free and the job finishes sooner. Tell the user in one line, with the two times. Two
exceptions stop you: data that may not leave the PC (step 1), and Kaggle's GPU quota running out
(kaggle-offload says so). When it answers `PC`, run it here.

The limits are the user's: `~/.green-compute/config.json`, e.g. `{"cpuMaxPercent": 60, "cpuMaxMinutes": 10}`.
Times are rough (GPU ones most of all): trust the verdict when the gap is large, and say "about".
While a job runs, the control room also flags the PC when the CPU stays above the limit for a minute.

### 4. Is it one of the user's direct tasks?

Read the settings first: `GC/config.mjs`. When `direct` is set and the job is one of its `tasks`
(`translate`, `summarize`, `classify`, `extract`, `draft`), it goes **straight to `direct.model`** on
OpenRouter, with no pilot against Claude: the user has already decided. Step 1 still holds (no personal
or confidential data), and so does the cost check: say the estimate in one line if it's over a dollar.

1. Write `jobs.jsonl` (one `{"id", "prompt"}` per item) and the instruction as `--system`.
2. Run the first 3 items, read them, fix the instruction if needed:
   `GC/or-batch.mjs --model <direct.model> --in jobs.jsonl --out results.jsonl --system "<rules>" --reasoning none`
   (`--reasoning low` for summaries and drafts if `none` reads flat). Then run the same command on the
   whole file: it resumes and does the rest.
3. Drafts (`draft`) are first versions: Claude rereads and fixes them before they go anywhere.
   Extractions: check that every line is valid JSON with the expected fields.

A job that is none of those tasks, or is mixed, goes on to step 5.

### 5. Is it bulk text work with clear rules?

Many items, the same instruction, a template or examples to follow → candidate for an **open model on
OpenRouter**, called from a script so the Claude session stays where it is:

1. **Check live prices and models**, never from memory: `GC/or-models.mjs` (group `chinese` by default;
   `--group free|gemini|others|all`, `--json`). Compare with Claude's blended price printed below it.
2. **Pilot**: run 5-10 representative items on the open model **and** do the same items on Claude (or
   take approved outputs). Compare them side by side with the user. Go on only if quality holds.
3. **Run the batch**: `GC/or-batch.mjs --model <id> --in jobs.jsonl --out results.jsonl --system "<rules>"`.
   `jobs.jsonl` has one `{"id", "prompt"}` per line; a stopped run resumes; the cost OpenRouter reports
   is printed at the end. Needs an OpenRouter key (`OPENROUTER_API_KEY`, or the plugin's `.env`). For simple tasks add `--reasoning none` (or `low`):
   many models otherwise think before answering, which costs tokens and can use up `--max-tokens`
   (an empty answer is recorded as an error and retried on the next run).
4. **Verify a sample on Claude** (more when errors cost more), as token-diet would for a production phase.

### 6. Is the plan running out?

When the weekly limit is near and the remaining work is not sensitive, the whole conversation can move
to an open model with `/or` (Windows; it opens a new window on the same session) and come back with
`/claude`. Long agentic sessions are hard for many models: prefer the newest large ones, and come back
to Claude for verification. Without the mod, the user can start Claude Code on OpenRouter by hand
(`ANTHROPIC_BASE_URL=https://openrouter.ai/api`, the key as `ANTHROPIC_AUTH_TOKEN`).

### 7. Everything else

Stays on Claude, and **token-diet** decides model and effort phase by phase.

## When NOT to use it

- Short tasks: the evaluation costs more than it saves. Just do them.
- When the user has already chosen where the job runs: respect it, one line of note at most.

## How you answer

Short, in the user's language:

```
Where to run <job>
- <part 1>: <place> (<model or engine>). Why: <one line>.
- <part 2>: ...
- Stays on Claude: <part>, because <cost of the error or the data>.
Cost: <live figure or order of magnitude, with its source>.
Next: <the pilot, the command, or "I'll hand it to token-diet / kaggle-offload">.
```

## Examples

- **Translate 2,000 product descriptions to a style guide**: pilot 10 on a Chinese open model and on
  Sonnet; if equal, `or-batch` on the open model, then Sonnet checks a 5% sample.
- **Transcribe 40 hours of interviews**: Whisper on Kaggle GPU via kaggle-offload; the PC stays free.
  If the recordings are confidential, ask before sending them anywhere.
- **Refactor a module and write its tests**: Claude, token-diet for the phases. Not an open model batch:
  it needs judgement and the codebase's context.
- **Classify 10,000 support tickets** with no personal data: open model batch after a pilot; tickets that
  mention names or emails stay on Claude or are anonymised first.
- **Out of plan on Thursday, still drafting blog posts**: `/or` to a large open model for the drafts,
  `/claude` on Monday for the final review.

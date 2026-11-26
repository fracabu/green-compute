<div align="center">

<img src="docs/logo.svg" alt="green-compute logo: a leaf whose veins are circuit traces ending in four nodes" width="150">

# green-compute

**Spend less compute for the same work: each job on the cheapest engine that does it well.**

A Claude Code plugin bundle · Claude where it matters, open models where they're enough, free GPUs for the heavy lifting, your CPU left free

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757)
![Node 18+](https://img.shields.io/badge/node-18%2B-5fa04e)

</div>

## Why

Most AI work runs on the most expensive engine by default. Yet a long job is made of parts that need very different things: reading and sorting, writing to a template, transcribing audio, checking that what ships is right. Only some of it needs the top model; some of it doesn't need a frontier model at all; some of it needs a GPU your laptop doesn't have.

green-compute puts four tools behind one question, **where should this run?**, so you pay with money, plan quota or your machine's time only where it buys quality.

## What's inside

| Plugin | What it does |
|---|---|
| **green-compute** | the `where-to-run` skill: decides between Claude, an open model on OpenRouter, Kaggle's free GPUs and your PC; scripts to read OpenRouter's live prices and to run text batches on an open model |
| [**token-diet**](https://github.com/fracabu/token-diet) | the right Claude model and effort for each phase of a job, with a live monitor of what you save |
| [**kaggle-offload**](https://github.com/fracabu/kaggle-offload) | runs heavy AI jobs on Kaggle's free GPUs (about 30 hours a week), batches them, tracks the quota |
| [**or-switch**](https://github.com/fracabu/or-switch) | `/or` moves the conversation to an OpenRouter model (DeepSeek, Kimi, Qwen, GLM, Gemini, free ones), `/claude` brings it back. Windows |

Installing green-compute installs the other three as dependencies. Each one can also be installed on its own.

## How it decides

```mermaid
flowchart TD
    A[A job] --> B{Personal or<br/>confidential data?}
    B -->|yes| C[Claude or this PC only]
    B -->|no| D{Error reaches clients,<br/>public, money?}
    D -->|yes| E[Claude<br/>token-diet per phase]
    D -->|no| F{Needs a GPU model?<br/>audio, images, video}
    F -->|yes| G[Kaggle GPU<br/>kaggle-offload]
    F -->|no| H{Bulk text work<br/>with clear rules?}
    H -->|yes| I[Pilot, then open model<br/>on OpenRouter]
    H -->|no| E
    I --> J[Claude checks a sample]
```

Before any bulk run on an open model, the skill runs a **pilot**: the same 5-10 items on the open model and on Claude, compared side by side. It only goes on if quality holds, and a sample of the batch is checked on Claude afterwards.

## Install

In a Claude Code session (2.1.275 or later):

```
/plugin install green-compute --marketplace fracabu/green-compute
```

Or only one piece: `/plugin install token-diet --marketplace fracabu/green-compute` (same for `kaggle-offload` and `or-switch`).

**Which scope?** Choose **user scope** ("install for you"), so you get it in every project. The skills cost only their one-paragraph descriptions until a job calls for them, and or-switch only adds two commands. Pick **local scope** instead if you want it in some repositories only, or **project scope** to share it with a team through the repository's settings.

Then, for the parts you'll use:

- **OpenRouter**: an API key from [openrouter.ai](https://openrouter.ai), in `OPENROUTER_API_KEY` (`setx OPENROUTER_API_KEY "sk-or-v1-..."` on Windows).
- **Kaggle**: `pip install kaggle`, a Kaggle account with a verified phone number and an API token: see [kaggle-offload](https://github.com/fracabu/kaggle-offload#quick-start).
- **Plan usage in token-diet's monitor**: an optional status line, see [token-diet](https://github.com/fracabu/token-diet#optional-plan-usage-in-the-monitor).

## Usage

Just ask Claude: *"where should this run?"*, *"can DeepSeek do this part?"*, *"translate these 500 files cheaply"*, *"I'm out of Claude for the week"*, *"keep my CPU free"*. The scripts also work on their own, from the plugin's folder:

| Command | What it does |
|---|---|
| `node scripts/or-models.mjs` | newest Chinese open models with tool calling and their live prices, next to Claude's |
| `node scripts/or-models.mjs --group free` | the same for free models (`gemini`, `others`, `all` too; `--json` for scripts) |
| `node scripts/or-batch.mjs --model <id> --in jobs.jsonl --out results.jsonl --system "<rules>" --reasoning none` | runs `{"id", "prompt"}` lines on an OpenRouter model, 4 at a time, retries on rate limits, resumes a stopped run, prints the cost OpenRouter reports. `--reasoning none` or `low` for simple tasks |

Example from `or-models.mjs` on 27 November 2026, blended price per million tokens (85% input, 15% output): `deepseek/deepseek-v4.1-flash` $0.07, `qwen/qwen4-max` $1.85, `moonshotai/kimi-k3.1-pro` $1.46, against Claude Haiku $0.16, Sonnet $3.20, Opus $6.40. Prices change: the script reads them live every time.

## Privacy and limits

- **OpenRouter and Kaggle are third parties.** Whatever you send there (prompts, files, audio) leaves your machine and Anthropic. The skill keeps personal and confidential data away from both, and asks when unsure.
- **Open models are not Claude.** They can be excellent at bulk text work and weak at long agentic sessions. That's why there is a pilot before every batch and a check after it.
- **Prices are read live**, never quoted from memory: the figures above are an example with their date.
- Nothing here stores your keys: OpenRouter's is read from the environment, Kaggle's stays where Kaggle puts it.

## Status

Tested on Windows 11. `or-models.mjs` and `or-batch.mjs` against the live OpenRouter API (a first live batch of translations on DeepSeek: with reasoning on, one answer came back empty because thinking used up `--max-tokens`; now that is an error that gets retried, and `--reasoning none` brought the cost down about tenfold), plus a local mock for retries and resume. Still to test: or-switch's full hand-off with a real key. macOS and Linux: untested, and or-switch needs a shell version of its launcher. Issues and reports are welcome.

## License

[MIT](LICENSE) · made by [@fracabu](https://github.com/fracabu)

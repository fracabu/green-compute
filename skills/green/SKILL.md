---
name: green
description: >-
  Runs a job the green-compute way, on the user's explicit request: opens the control room in the
  browser, decides with where-to-run where each part should run (Claude with token-diet, an open model
  on OpenRouter, Kaggle's free GPUs, this PC), then does the job and shows it all live.
argument-hint: <the job, in a sentence>
disable-model-invocation: true
---

# /green

The user typed `/green` before a job: they want it done with green-compute and watched live.
The job: **$ARGUMENTS**

If the job above is empty, ask for it in one line and stop.

1. **Open the control room** with the job as the run's title (short, under 80 characters):
   `node "${CLAUDE_PLUGIN_ROOT}/control-room/start.mjs" --title "<short title of the job>"`
   It starts the server on http://localhost:4790 if needed, starts a new run and opens the page. From
   here on, the plugin records on its own which skill is working, every sub-agent and its model, the
   tokens of every turn and the batches sent to OpenRouter or Kaggle: you don't write events by hand.
2. **Decide where each part runs** by following the `where-to-run` skill (load it): data, cost of an
   error, GPU need, bulk text work. Answer in its format, then go on unless a step needs the user's word
   (a pilot to compare, data that would leave the PC, money beyond a few cents).
3. **Do the job** with the skill each part needs:
   - parts on Claude with sub-agents → `token-diet` (model and effort per phase; its own monitor is
     optional here, the control room already shows the agents);
   - bulk text on an open model → the pilot, then `or-batch.mjs` as `where-to-run` says;
   - GPU work → `kaggle-offload`.
4. **Close** with what ran where, what it cost (the control room's figures: measured, all-on-Opus,
   OpenRouter, Kaggle hours) and what is left to do.

---
kind: living
status: current
---

# Benchmark

**Open Benchmark** (View menu, Command Palette, `benchmark.open`) opens a standalone Benchmark window that runs one prompt against
several Agent, model, and effort combinations and compares what each produced, how long it took, and what it cost. It
answers "which model should I use for this kind of task" with the user's own prompt and the real installed CLIs
(Claude Code, Codex, Grok Build), instead of a public leaderboard measured on someone else's tasks.

## Using it

1. Write a prompt.
2. Pick Entries in the model picker. Each Agent lists the models its installed CLI and signed-in account offer, and each
   model offers its efforts as chips; every pressed chip is one Entry. Refresh re-reads the providers.
3. Choose where the Attempts run: an **empty folder** (a fresh Git repository, for greenfield prompts) or any added
   **Project** (a clone of its current commit, so uncommitted changes are not included). A Project that is a subfolder of
   a Git repository (a monorepo package) works too: Attempts clone the whole repository, work in that subfolder, and
   their diffs cover only it.
4. Optionally adjust the judge, a check command, repeats, concurrency, and the per-Attempt timeout, then start.

The board updates live: every Entry's row shows its status, elapsed time, and step count while it runs. When the run
finishes it shows:

- Headline tiles: the best Entry, the total spend (Attempts plus the judge), total tokens split into input, output,
  and cache, wall time, and completed Attempts.
- A scatter chart in the style of public coding-agent leaderboards: quality on the vertical axis, and cost, time,
  output tokens, steps, time to first token, output speed, or cache hit rate on the horizontal axis, oriented so the
  better value (cheaper, faster, more cache hits) sits on the right. One model's efforts are joined by a line in the
  Agent's color, labeled with the effort, and the top-right corner reads "most efficient".
- A ranked table (quality, then completion rate, cost, and time). A row expands to each Attempt's measurements (the
  full token breakdown, cache hit rate, time to first token, output speed, peak and final context, and compactions),
  judge reason, final answer, and diff, plus the check output when a check command ran. Wide panes add first-token,
  cache-hit, and peak-context columns; narrow panes drop those and the token, step, and change columns, and the
  expanded row still shows them.

**Run again** copies a finished run's settings into the New run form. Past runs stay in the left column until deleted.

**Share** (beside Run again, once a run has results) exports a share card: the prompt summary, the scatter chart, the top five leaderboard rows, the date, the judge model, and a "Made with Caxri" credit, drawn in the current theme at 2x. Choose **Copy image** to put it on the clipboard or **Save as PNG** for the native save dialog. The card is rasterized in the window and nothing is uploaded.

## The window

Like the [Agent Commander](agent-commander.md), the Benchmark window is a companion window: it shares the Workbench
preload and Main's single connection to the Server, and Main admits its requests through its own allowlist
(`apps/desktop/src/main/benchmark-window-policy.ts`): the `benchmark.*` methods, the Workbench snapshot it reads for
locale, theme, and Projects, Settings and theme reads, and link handling. Anything else is refused and logged as
`benchmark_window.request_denied`. It receives durable events plus `benchmark.changed` and connection changes.
Opening it again focuses the existing window. Its size and position are remembered while the app runs, not across
restarts, and it is not reopened at startup. It is local-machine only: an SSH Workbench does not offer it.

## How a run works

The Server owns every run (`apps/server/src/domains/agent-benchmark/`); closing the Benchmark window or the Workbench window does not stop it.

- **Attempts.** Each Entry runs `repeats` times. Every Attempt gets its own folder under the Server's
  `benchmarks/runs/<runId>/` data directory. Project mode clones the Project's repository with its remote removed and
  checks out the commit `HEAD` pointed at when the run started; the Project folder itself is never written. At most
  `concurrency` Attempts run at once.
- **Agent turn.** An Attempt drives the provider through the same Agent Chat driver a Chat uses, as one headless turn
  with no Session, Terminal, or database row. It launches the user's configured executable with the provider's autonomy
  flag, and the Entry's model and effort replace any model or profile the user's TUI arguments pin. Approvals are
  accepted, since nobody is watching. The timeout and Cancel both stop the provider process.
- **Measurements.** Wall time comes from the turn. Steps count the commands, file changes, and tool calls in the turn.
  Time to first token runs from sending the prompt to the Agent's first output in the Chat stream. Peak and final
  context come from the usage the Agent reports after each response, measured against the window it compacts at, and
  compactions count its `compacted` notices; every provider reports these through the same Chat projection. Tokens come
  from the Agent's transcript; the cache hit rate is cache reads over all input (uncached, cache read, cache write).
  Output speed divides output tokens by the model's own generation time from the same transcript, so tool and command
  time never count; Grok Build's transcript records no response timing, so its speed reads "not available". Cost is Grok Build's own report, or the API list price of the tokens (the
  same price list Usage uses); a model without a price shows "unknown", never zero. The diff is everything the Agent
  changed against the starting commit, its own commits included.
- **Check command.** When set, it runs in each completed Attempt's folder; exit code 0 passes. Without a judge, the
  pass rate becomes the quality axis.
- **Judge.** After every Attempt finishes, one judge model scores all completed Attempts from 0 to 100 in one blind
  pass. Each Attempt appears under a shuffled letter with only its answer and diff, never its Agent, model, effort,
  cost, or time. The default judge is the first ready Agent's default model, preferring Claude Code, then Codex, then
  Grok Build. With the judge off and no check command, the chart plots time against the chosen metric and nothing is
  ranked best.

The run's prompt, settings, and results persist as one JSON document per run in the `benchmark_runs` table and publish
`benchmark.changed` on each transition (`kind: 'transition'`, which also refreshes the history list) and, at most once a
second, on live step progress (`kind: 'progress'`, which refreshes only that run's own view). Deleting a run removes that row and its Attempt folders. A Server that stops
mid-run cancels its providers first; the next Server closes any unfinished Attempt as `serverRestarted`, because a
provider process does not survive a restart.

## Limits

The contract bounds a run (`packages/protocol/src/agent/agent-benchmark-contract.ts`): up to 24 Entries, 5 repeats, a
concurrency of 8, and a 120-minute Attempt timeout. Stored answers and diffs are capped, and what the judge reads is
clipped further: each candidate's answer and diff, and the whole judge prompt to 400,000 characters shared equally by
the candidates, so a large run is still scored. Logs record run and Attempt outcomes with closed reasons and durations, never the prompt, answers, or
diffs.

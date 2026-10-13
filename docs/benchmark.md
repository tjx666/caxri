---
kind: living
status: current
---

# Benchmark

**Open Benchmark** (View menu, Command Palette, `benchmark.open`) opens a Workbench tab that runs one prompt against
several Agent, model, and effort combinations and compares what each produced, how long it took, and what it cost. It
answers "which model should I use for this kind of task" with the user's own prompt and the real installed CLIs
(Claude Code, Codex, Grok Build), instead of a public leaderboard measured on someone else's tasks.

## Using it

1. Write a prompt.
2. Pick Entries in the model picker. Each Agent lists the models its installed CLI and signed-in account offer, and each
   model offers its efforts as chips; every pressed chip is one Entry. Refresh re-reads the providers.
3. Choose where the Attempts run: an **empty folder** (a fresh Git repository, for greenfield prompts) or the Session's
   **Project** (a clone of its current commit, so uncommitted changes are not included).
4. Optionally adjust the judge, a check command, repeats, concurrency, and the per-Attempt timeout, then start.

The board updates live: every Entry's row shows its status, elapsed time, and step count while it runs. When the run
finishes it shows:

- Headline tiles: the best Entry, the total spend (Attempts plus the judge), wall time, and completed Attempts.
- A scatter chart in the style of public coding-agent leaderboards: quality on the vertical axis, and cost, time,
  output tokens, or steps on the horizontal axis, reversed so cheaper or faster sits on the right. One model's efforts
  are joined by a line in the Agent's color, labeled with the effort, and the top-right corner reads "most efficient".
- A ranked table (quality, then completion rate, cost, and time). A row expands to each Attempt's judge reason, final
  answer, and diff, plus the check output when a check command ran. Narrow panes drop the token, step, and change
  columns; the expanded row still shows them.

**Run again** copies a finished run's settings into the New run form. Past runs stay in the left column until deleted.

## How a run works

The Server owns every run (`apps/server/src/domains/agent-benchmark/`); closing the tab or the window does not stop it.

- **Attempts.** Each Entry runs `repeats` times. Every Attempt gets its own folder under the Server's
  `benchmarks/runs/<runId>/` data directory. Project mode clones the Project's repository with its remote removed and
  checks out the commit `HEAD` pointed at when the run started; the Project folder itself is never written. At most
  `concurrency` Attempts run at once.
- **Agent turn.** An Attempt drives the provider through the same Agent Chat driver a Chat uses, as one headless turn
  with no Session, Terminal, or database row. It launches the user's configured executable with the provider's autonomy
  flag, and the Entry's model and effort replace any model or profile the user's TUI arguments pin. Approvals are
  accepted, since nobody is watching. The timeout and Cancel both stop the provider process.
- **Measurements.** Wall time comes from the turn. Steps count the commands, file changes, and tool calls in the turn.
  Tokens come from the Agent's transcript. Cost is Grok Build's own report, or the API list price of the tokens (the
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
`benchmark.changed` on each transition. Deleting a run removes that row and its Attempt folders. A Server that stops
mid-run cancels its providers first; the next Server closes any unfinished Attempt as `serverRestarted`, because a
provider process does not survive a restart.

## Limits

The contract bounds a run (`packages/protocol/src/agent/agent-benchmark-contract.ts`): up to 24 Entries, 5 repeats, a
concurrency of 8, and a 120-minute Attempt timeout. Stored answers and diffs are capped, and what the judge reads is
clipped further. Logs record run and Attempt outcomes with closed reasons and durations, never the prompt, answers, or
diffs.

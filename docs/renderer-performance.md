---
kind: living
status: current
---

# Renderer performance observability

Caxri measures one explicitly named Renderer scenario at a time and emits a bounded,
machine-readable receipt. This is local diagnostics, not telemetry: nothing is uploaded, and normal
production builds do not expose the browser control API.

## What is measured

Each `renderer-performance-scenario` receipt contains:

- `requestAnimationFrame` interval percentiles, the detected refresh interval, and an estimated
  missed-frame count;
- Long Animation Frame counts, duration, blocking duration, and style/layout duration when Chromium
  exposes the API;
- Event Timing input, processing, and presentation delay maxima when Chromium exposes the API;
- React Profiler commit and render counts for the Primary Sidebar, Workbench, and Secondary Sidebar,
  with per-surface p50, p95, maximum, total actual duration, and maximum base duration;
- fixed `session.select` and `app.bootstrap` request counts, total duration, and maximum duration.

Capabilities are explicit. An unavailable browser observer or a normal production React build
produces `unavailable` or `disabled`; it never silently produces a meaningful-looking zero.
`visibilityInterrupted` and `focusInterrupted` make a sample unsuitable for a strict frame budget.

The React Profiler summaries describe the stable surface boundaries, not every component.
Component attribution is deliberately not shipped. `react-scan/lite` 0.5.7 was tested against the
profiling React 19.2 build, but exposed only commit-tree data and every measured commit violated the
parent/child duration relationship required to derive self time. Its fiber `actualDuration` is also
subtree-inclusive, so a component ranking would double-count work and misidentify ancestors as
bottlenecks. The dependency and opt-in entry were removed rather than preserving an unusable tool.

## Repeatable benchmark

Run the profiling build and real Electron scenario with:

```bash
bun run benchmark:renderer
```

The command prints exactly one receipt prefixed by `CAXRI_RENDERER_BENCHMARK` and writes the same JSON
to `test-results/receipts/renderer-performance.json`. The fixture creates eight Sessions and thirty
files across five nested directories, expands `src/features` in both source and target workspaces,
then measures exactly one Session-card click. Readiness requires the target Session, Terminal, and
Files surface to be visible, two presented frames, and no pending measured request.

The budgets below were calibrated from three local profiling runs before and after removing the
duplicate post-selection refresh on 2026-08-31. Before the repair, every run issued one
`session.select` plus two full `app.bootstrap` reads; those reads took `7.2–7.5 ms` in total. After
the repair, every run issued exactly one of each and the bootstrap segment took `2.7–3.4 ms`,
removing `53–64%` of the full-snapshot read cost. The wall-clock range stayed `67.4–69.1 ms` because
the scenario deliberately waits for two complete presentation frames.

React was not the bottleneck: all six comparison runs recorded exactly `7`, `5`, and `3` renders
for the Primary Sidebar, Workbench, and Secondary Sidebar. The optimized runs' maximum total React
durations were `1.8 ms`, `1.3 ms`, and `1.0 ms`, respectively. Those surface totals did not justify
speculative component memoization; the attempted react-scan component ranking was rejected for the
inconsistent timing data described above.

| Surface           | Required renders | Maximum renders | Maximum total actual duration |
| ----------------- | ---------------: | --------------: | ----------------------------: |
| Primary Sidebar   |                1 |              12 |                          8 ms |
| Workbench         |                1 |               8 |                          6 ms |
| Secondary Sidebar |                1 |               6 |                          5 ms |

The benchmark also requires one `session.select`, one `app.bootstrap`, each request below `100 ms`,
an end-to-end duration below `500 ms`, no frame interval at or above `100 ms`, a focused and
uninterrupted profiling window, bounded sample storage, and a matching structured-log record. The
refresh-rate estimate, interval percentiles, missed-frame estimate, Long Animation Frames, and Event
Timing remain diagnostic because display refresh rate and runner load make them too noisy for tighter
CI budgets.

The trusted macOS E2E job runs this command after the ordinary production-build suites. It rebuilds
only for this final profiling scenario, uploads the JSON receipt for seven days, and exposes the step
outcome to `CI gate`; a skipped or failed performance step rejects every E2E-running path. Workflows
whose policy explicitly skips E2E do not start the desktop job. The performance spec itself is protected
from focused repair selection because a normal React build cannot supply valid Profiler timings; the
dedicated profiling step still runs after a successful focused repair.

Compare only like-for-like machine, build mode, scenario, and visibility/focus state. Keep budgets
scenario-specific; do not turn one local sample into a repository-wide threshold.

## Agent Chat Session switch

Switching to a Session whose Workbench shows an Agent Chat has its own profiling-build benchmark:

```bash
bun run benchmark:chat-switch
```

The fake Codex Chat answers sixteen Markdown-heavy turns (tables and highlighted code blocks), so the
transcript is many screens tall, and the user leaves it following the latest reply. One Session-card
click back to that Chat is then measured from each state a Session can be in:

- `keptAlive`: the Chat is still among the five most recently selected Sessions (the visible one
  included) whose Workbench stays mounted;
- `cached`: newer Sessions evicted it from keep-alive, while the Renderer's query cache still holds
  its conversation;
- `uncached`: after a Renderer reload nothing is cached, and the switch reads the conversation from
  Server Core.

The click and the sampling run inside the page, one sample per painted frame. An animation-frame
callback runs before that frame's layout and resize observers, which is where the Chat pins its view
to the end, so each sample is taken from a task posted from that callback instead. Each switch is
also bracketed as a Renderer `session.switch` scenario, so the receipt carries the same per-surface
React Profiler renders and actual duration as `benchmark:renderer`. The command prints one receipt
prefixed by `CAXRI_AGENT_CHAT_SWITCH_BENCHMARK` and writes the same JSON to
`test-results/receipts/agent-chat-session-switch.json`. `agentChat.read` requests are counted by
distinct request id from `server-core.jsonl`, because Server Core records each Renderer request twice
(where the control relay admits it and where its domain answers it).

The gates are the deterministic invariants plus React budgets. In every scenario the conversation
appears, no painted frame shows the Session with neither placeholder turns nor real ones, and for
thirty frames after the turns appear every frame shows the end of the conversation. A kept-alive
Chat draws its turns in the first frame, with no placeholder, no `scroll` event, and no read. A
cached Chat draws without a placeholder or a read. An uncached one reads exactly once. Each surface
stays within the render and duration budget in `e2e/agent-chat-switch.performance.e2e.ts`; the
kept-alive Workbench budget is the one that catches a switch back rendering the transcript again.
Times and frame gaps stay diagnostic.

A fourth measurement covers a Chat that keeps working while the user looks elsewhere. The fake
Codex streams a long reply into the Chat while its Session is kept alive behind another one, and the
Workbench's React work over five seconds of that stream must stay within `HIDDEN_STREAM_BUDGET`.
Switching back to the still-streaming Chat must draw its turns in the first frame, with no
placeholder and no read. The receipt records both under `hiddenStreaming`.

Three local profiling runs on 2026-10-21 (Apple Silicon, hidden window, five kept-alive Sessions)
measured, in milliseconds from the click:

| Scenario    | Session shown | Placeholder | Conversation | Longest frame gap | `agentChat.read` | Workbench renders | Workbench React |
| ----------- | ------------: | ----------: | -----------: | ----------------: | ---------------: | ----------------: | --------------: |
| `keptAlive` |     26.3–28.3 |        none |    26.3–28.3 |         20.7–27.5 |                0 |                 4 |         0.7–1.1 |
| `cached`    |     60.0–64.7 |        none |    60.0–64.7 |         53.2–64.7 |                0 |                10 |       15.5–19.4 |
| `uncached`  |     30.1–51.8 |   30.1–51.8 |    73.5–96.2 |         43.4–57.8 |                1 |             12–13 |       24.7–38.6 |

While the Chat streamed hidden, the Workbench rendered 5 times in 0.3 ms of React per five seconds
in every run, and switching back to it drew its turns in `30.3–32.7 ms` with no read.

The Primary Sidebar rendered twice in every run, and the Secondary Sidebar three to six times, each
under `1 ms` in total. Three production-build runs of this benchmark against an earlier Renderer on
2026-10-20 showed what the gates now reject: every `keptAlive` switch fired one programmatic
`scroll` event (the overlay scrollbar flashing), and every `uncached` switch painted one or two blank
frames before the turns arrived, with no placeholder. Its conversation times were `25.9–26.6`,
`54.6–58.3`, and `95.7–103.7`, so the repair did not trade speed for those invariants.

### Tail-first mount

A Chat pane that mounts with a conversation already in the cache (`cached`, `uncached`) first commits only
the last four live timeline entries, then adds older entries above them in idle batches of six until the
whole timeline is mounted (`transcript/mount/use-agent-chat-tail-first-mount.ts`). Entries keep their
keys, so a batch only adds rows; a view following the end stays on it (the content resize observer
re-pins before paint) and a view reading history is held by the browser's scroll anchoring. Opening find
mounts every entry at once so a search never misses an early turn. The first non-empty timeline decides
the tail, so a Chat that streams from empty mounts normally. Keep the tail long enough to fill a view: with
two entries or fewer the first frame was shorter than the view and a later batch painted away from the end.

Set `CAXRI_AGENT_CHAT_SWITCH_BENCHMARK_TURNS` to seed a longer conversation. Local profiling runs on
2026-10-30 measured the `cached` longest frame gap and Long Animation Frame:

| Turns | Mount      | Longest frame gap | Long Animation Frame |
| ----: | ---------- | ----------------: | -------------------: |
|    16 | whole      |        82.0-104.1 |            77.4-98.9 |
|    16 | tail first |         36.1-48.0 |                    0 |
|    64 | whole      |             309.7 |                292.4 |
|    64 | tail first |              36.1 |                    0 |

The shell of the Session (composer, header, sidebars) costs about 25-30 ms on its own, so the 34 ms goal
is not met on every run; `CACHED_FRAME_BUDGET` gates 65 ms and 50 ms.

### Retention and hidden Chats

Three choices, measured on 2026-10-21 against the previous Renderer in the same profiling build, keep
these paths fast. They follow T3 Code's Session-switch work (see the competitors skill's feature
references).

- **Five kept-alive Sessions.** Switching back to the fourth most recent Session (the sixteen-turn
  Chat) took `64.8 ms` with 21 ms of Workbench React as a remount, and `26.6 ms` with 1 ms while it
  was still mounted. Each retained Chat of that size costs about 6 MB of JS heap and 4,300 DOM
  nodes. GPU contexts do not bound the limit, because a hidden Session releases its WebGL contexts;
  `SESSION_KEEP_ALIVE_LIMIT` in
  `apps/desktop/src/renderer/src/features/workbench/session-keep-alive.ts` documents the budget.
- **A hidden Chat stops following its stream.** Before, a kept-alive Chat streaming out of sight
  cost the Workbench as much as a visible one: 1,368 renders and 134 ms of React per five seconds.
  Its pane now keeps observing the cached conversation without being notified of each change
  (`agentChatReadFollowOptions`), which measured 5 renders and 0.6 ms. `agentChat.patch` keeps the
  cache current, so showing the Session renders the latest conversation once. Only the Chat pane does this; a Context,
  task, or turn review tab of the same Chat open in a hidden Session still follows it.
- **Sixteen cached conversations instead of five minutes.** React Query's default dropped a Chat's
  cached conversation five minutes after its pane unmounted, so returning later showed the
  placeholder turns and read it again. `agentChat.read` snapshots now stay cached until sixteen
  other Chats nobody is observing were left after them
  (`apps/desktop/src/renderer/src/features/agent-chat/agent-chat-cache-retention.ts`). Each one is
  bounded by the projection limits, and a kept-alive Chat still counts as observed.

Prefetching the most recent Chats after a Renderer reload was measured and not adopted. It removed
the placeholder from the first switch (`59.5–70.9 ms` against `64.6–85.2 ms`), but `agentChat.read`
starts a Chat's provider when it is not running, and after an ordinary relaunch none is, so a
prefetch would start Agent processes for Chats the user never opens.

A kept-alive Session stays laid out off screen (`content-visibility: hidden`, see
`apps/desktop/src/renderer/src/features/workbench/workbench.tsx`), which is why it returns on the
first frame at the line the user left. Its wrapper carries no `inert` and no descendant `[hidden] *` rule, because
either one makes Chromium restyle the whole subtree when the Session shows again. The `cached` scenario's longest frame is the remount
rendering the whole transcript at once.

## Agent Chat streaming

What a visible Agent Chat costs while a reply streams into it has its own profiling-build benchmark:

```bash
bun run benchmark:chat-streaming
```

The fake Codex Chat first answers one Markdown-heavy turn, so the Chat's lazy code is loaded, and the
app then sits idle for five seconds. Two workloads follow in the same Chat, each bracketed as a
Renderer `agentChat.stream` scenario:

- `bigstream`: a reply of about 50 KB of Markdown (headings, lists, tables, links, inline code, and
  fenced TypeScript) streamed in 24-character deltas;
- `toolstorm`: 300 commands that each start and complete, 600 tool updates in all, followed by a
  short reply.

Each window ends only after the workload's final text is visible and two more frames have painted.
The receipt records wall time, Renderer main-thread time from `Performance.getMetrics` (task, script,
style recalculation, layout), the Renderer JS heap after two forced collections before and after the
turn, whole-app resident memory (every Electron process from `app.getAppMetrics()` plus Server Core,
Terminal Host, and Extension Host; Agent processes excluded), React Profiler renders and duration,
Long Animation Frames, and missed frames. The command prints one receipt prefixed by
`CAXRI_AGENT_CHAT_STREAMING_BENCHMARK` and writes the same JSON to
`test-results/receipts/agent-chat-streaming.json`.

The gates are the per-workload Workbench render and React-duration budgets and the Renderer heap
growth budget in `e2e/agent-chat-streaming.performance.e2e.ts`. Main-thread time, frames, and
resident memory stay diagnostic: resident memory moves by tens of megabytes with allocator and GPU
behavior between identical runs, and frame readings depend on the machine.

The workloads and readings follow PandaCode's published comparison with T3 Code (see the
competitors skill's `pandacode.md`). Its numbers came from a different machine and harness, so
compare Caxri only against its own receipts.

Three local profiling runs on 2026-10-29 (Apple Silicon, hidden window) measured:

| Workload    |  Wall (s) | Renderer task (ms) |        Script / style / layout (ms) | Heap growth (MB) | Workbench renders | Workbench React (ms) | LoAFs |
| ----------- | --------: | -----------------: | ----------------------------------: | ---------------: | ----------------: | -------------------: | ----: |
| `bigstream` | 10.2–10.6 |        9,154–9,315 | 2,427–2,597 / 1,635–1,682 / 270–282 |        40.3–41.4 |       2,595–2,791 |              594–644 |     1 |
| `toolstorm` |   6.7–6.8 |        2,117–2,238 |           600–662 / 122–126 / 51–54 |          0.8–0.9 |               618 |              164–178 |     0 |

Idle, the app held 1,344–1,436 MB resident (Electron 1,044–1,135 MB, Server 300 MB) with a 42 MB
Renderer heap.

Two findings shaped the code. React accounts for well under a tenth of the `bigstream` main-thread
time. Script, style recalculation, and layout together explain about half of the task time; the other
half (paint, garbage collection, and other browser work) is not attributed by these metrics, so a
trace is the next step before optimizing it. A heap snapshot diff
showed the retained growth is mostly React hook state of controls that every code block and table
renders, not the Markdown itself. The fullscreen dialog behind each block's View Full Screen button was mounted
while closed; mounting it only while open lowered `bigstream` heap growth from 46.4 MB to about
41 MB. Most of the remainder is one tooltip root per toolbar button. The highlighted-code and diagram
caches (`MemoCache`) are bounded by characters as well as entries, so a few very large blocks cannot
hold an unbounded amount of markup.

## Development investigation

The small `caxriPerformance` API is available in development, E2E, and profiling builds. For an
interactive investigation, start the current worktree:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev
```

From the Workbench DevTools console, bracket one supported action and copy the receipt as inert JSON:

```js
const scenarioId = globalThis.caxriPerformance.begin('session.switch');
// Perform the action once.
JSON.stringify(globalThis.caxriPerformance.end(scenarioId), null, 2);
```

The supported actions are `session.switch`, for one Session switch, and `agentChat.stream`, for a
window in which a Chat receives streamed text or tool updates without user input. Starting a second scenario before ending the first
fails clearly. A scenario is automatically finalized after two minutes so observers cannot grow
without bound.

Do not infer a component bottleneck from one run or from subtree-inclusive Fiber durations. Start a
component investigation only after three exact-head runs identify the same Profiler surface as the
regression. Any future component-attribution tool must prove bounded, internally consistent self
time and an avoidable props/state/context/hook cause before it can justify a product-code change.

The Main-process copy is queryable by an Agent through the existing CLI:

```bash
caxri logs query --event renderer.performance_scenario --limit 20 --json
```

## Always-on jank log

Outside a named scenario the Workbench Renderer keeps a threshold-gated record of what a user would call
lag. `features/renderer-performance/jank-monitor.ts` installs a `long-animation-frame` observer and times
each `session.select` from the select command to the second animation frame after the Workbench applied
the result. A switch of 100 ms or more, or a Long Animation Frame of 100 ms or more in a visible window,
is queued; Chromium itself only reports frames from 50 ms, so a healthy Renderer wakes the observer
rarely. The reporter keeps the five slowest switches and frames per batch, counts the rest as omitted,
flushes two seconds after the first sample and at most once every ten seconds, and flushes when the
window hides. Desktop Main writes one `renderer.jank` record per batch (`warn` when a sample reached one
second, otherwise `info`) with flat fields; see the recipe in the `performance` skill.

Each frame carries the script that spent the most time in it: its invoker type, duration, forced
style/layout time, and the Caxri bundle chunk file name and function identifier. Both strings must match a
plain identifier pattern and are `null` otherwise, so no directory, URL, or user text can reach the log.

## Privacy and bounds

The Renderer-to-Main protocol is a strict allowlist. Receipts may contain fixed action/surface names,
opaque UUIDs, booleans, counts, and bounded durations. They cannot contain DOM text, Project or source
paths, component names, source locations, props, state, stack traces, Terminal output, prompts,
transcripts, credentials, or environment values.

The one exception is the `renderer-jank` batch above: its top-script attribution is limited to a
validated Caxri bundle chunk file name and function identifier, never a path or URL.

Frame timestamps and per-render samples exist only in Renderer memory during the active scenario. Main
persists the finished aggregate as flat scalar fields so `logs query` remains directly usable by
agents.

## Timing a reload with the Performance Monitor

Open `Open Performance Monitor Window`, then press `Reload` or `Hard reload`. The timeline lists
DOM ready, loaded, loader removed, and first frame in milliseconds from the navigation start. See
[performance-monitor.md](performance-monitor.md).

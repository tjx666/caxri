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

The same command also measures six alternating switches between two Agent Chat Sessions. Each
Session contains three synthetic table replies. A Chat sample ends only after the target Session's
own latest user message and all three reply tables are visible, followed by two presentation
frames. It prints `CAXRI_AGENT_CHAT_SWITCH_BENCHMARK` and writes
`test-results/receipts/agent-chat-switch.json`, including individual scenario receipts, median, and
p95. These timings establish a baseline; they do not inherit the Shell scenario's calibrated
latency budget. The fixture uses a repository-owned fake Codex and never invokes a host provider.

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

`session.switch` is the only supported action. Starting a second scenario before ending the first
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

## Privacy and bounds

The Renderer-to-Main protocol is a strict allowlist. Receipts may contain fixed action/surface names,
opaque UUIDs, booleans, counts, and bounded durations. They cannot contain DOM text, Project or source
paths, component names, source locations, props, state, stack traces, Terminal output, prompts,
transcripts, credentials, or environment values.

Frame timestamps and per-render samples exist only in Renderer memory during the active scenario. Main
persists the finished aggregate as flat scalar fields so `logs query` remains directly usable by
agents.

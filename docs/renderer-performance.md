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
- optional `react-scan/lite` commit, render, and slowest-component summaries in an instrumented build.

Capabilities are explicit. An unavailable browser observer, a normal production React build, or a
react-scan build limited to commit-tree data produces `unavailable`, `disabled`, or
`commit-tree-only`; it never silently produces a meaningful-looking zero. `visibilityInterrupted`
and `focusInterrupted` make a sample unsuitable for a strict frame budget.

The React Profiler summaries describe the stable surface boundaries, not every component.
`react-scan/lite` adds component attribution only in an opt-in monitoring build. It is
not the canonical schema and is never required for frame, Long Animation Frame, Event Timing, or
surface-level React measurements.

`react-scan/lite` owns React's profiling-hook channel while that instrumented window is running, so
the React DevTools Timeline Profiler may not receive events at the same time. Restart without
`CAXRI_RENDERER_MONITORING=1` when using the DevTools Timeline Profiler.

## Repeatable benchmark

Run the profiling build and real Electron scenario with:

```bash
bun run benchmark:renderer
```

The command prints exactly one receipt prefixed by `CAXRI_RENDERER_BENCHMARK` and writes the same JSON
to `test-results/receipts/renderer-performance.json`. The fixed scenario switches between two
Sessions, collapses and expands their Project, and hides and restores both sidebars three times. It
therefore requires every stable surface to participate instead of accepting one global aggregate.

The budgets below were calibrated from three local Apple M5 Max profiling runs on 2026-08-30. The
observed render-count ranges were `61–102`, `36–37`, and `26`; the observed maximum total durations
were `15.9 ms`, `7.7 ms`, and `5.2 ms`, respectively. Duration gates use roughly three times the
observed maximum, while render-count gates retain enough headroom for asynchronous state commits
without allowing an accidental whole-tree render per event to pass unnoticed. The exact-head CI run
on `m2-24` is the required cross-machine acceptance evidence.

| Surface           | Required renders | Maximum renders | Maximum total actual duration |
| ----------------- | ---------------: | --------------: | ----------------------------: |
| Primary Sidebar   |                1 |             140 |                         50 ms |
| Workbench         |                1 |              60 |                         30 ms |
| Secondary Sidebar |                1 |              45 |                         20 ms |

The benchmark also requires a focused, uninterrupted profiling window, bounded sample storage, and a
matching structured-log record. Frame intervals, missed frames, Long Animation Frames, and Event
Timing remain in the receipt for diagnosis but are not hard gates: display refresh rate and runner
load make those browser-level values too noisy for a deterministic CI budget.

The trusted macOS E2E job runs this command after the ordinary production-build suites. It rebuilds
only for this final profiling scenario, uploads the JSON receipt for seven days, and exposes the step
outcome to `CI gate`; a skipped or failed performance step rejects every E2E-running path. Workflows
whose policy explicitly skips E2E do not start the desktop job. The performance spec itself is protected
from focused repair selection because a normal React build cannot supply valid Profiler timings; the
dedicated profiling step still runs after a successful focused repair.

Compare only like-for-like machine, build mode, scenario, and visibility/focus state. Keep budgets
scenario-specific; do not turn one local sample into a repository-wide threshold.

## Development investigation

The small `caxriPerformance` API is available in development, E2E, and profiling builds. To add
component attribution through `react-scan/lite`, start the current worktree with instrumentation
enabled:

```bash
CAXRI_RENDERER_MONITORING=1 \
  bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev
```

From the Workbench DevTools console, bracket one supported action and copy the receipt as inert JSON:

```js
const scenarioId = globalThis.caxriPerformance.begin('session.switch');
// Perform the action once.
JSON.stringify(globalThis.caxriPerformance.end(scenarioId), null, 2);
```

Supported actions are `benchmark.renderer`, `session.switch`, `terminal.resize`, `files.expand`, and
`editor.open`. Starting a second scenario before ending the first fails clearly. A scenario is
automatically finalized after two minutes so observers cannot grow without bound.

The Main-process copy is queryable by an Agent through the existing CLI:

```bash
caxri logs query --event renderer.performance_scenario --limit 20 --json
```

## Privacy and bounds

The Renderer-to-Main protocol is a strict allowlist. Receipts may contain fixed action/surface names,
opaque UUIDs, booleans, counts, and bounded durations. They cannot contain DOM text, Project or source
paths, source locations, props, state, stack traces, Terminal output, prompts, transcripts,
credentials, or environment values. Optional component names are restricted to a short safe character
set; rejected names are discarded and mark the receipt as truncated.

Frame timestamps and per-render samples exist only in Renderer memory during the active scenario. Main
persists the finished aggregate as flat scalar fields so `logs query` remains directly usable by
agents.

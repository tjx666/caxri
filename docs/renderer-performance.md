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
  with bounded duration percentiles;
- optional `react-scan/lite` commit, render, and slowest-component summaries in an instrumented build.

Capabilities are explicit. An unavailable browser observer, a normal production React build, or a
react-scan build limited to commit-tree data produces `unavailable`, `disabled`, or
`commit-tree-only`; it never silently produces a meaningful-looking zero. `visibilityInterrupted`
and `focusInterrupted` make a sample unsuitable for a strict frame budget.

The React Profiler summaries describe the stable surface boundaries, not every component.
`react-scan/lite` adds component attribution only in an opt-in monitoring or profiling build. It is
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

The command prints exactly one receipt prefixed by `CAXRI_RENDERER_BENCHMARK`. The benchmark verifies
that the profiling build exposes the React Profiler, produces React commits and frame samples, stays
within its scenario budgets, and persists the same scenario under the
`renderer.performance_scenario` structured-log event.

Compare only like-for-like machine, display refresh rate, build mode, scenario, and visibility/focus
state. Keep budgets scenario-specific; do not turn one local sample into a repository-wide threshold.

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

---
name: performance
description: Measure and protect Caxri startup, Server Core responsiveness, and Renderer interaction quality. Use for slow launch or Session restore, repeated Server Core requests, watcher or file-descriptor growth, PTY responsiveness, Git or Agent probe latency, logging overhead, React re-renders, frame gaps, or Renderer bundle regressions.
---

# Measure Caxri Performance

1. Choose a representative large repository. Never benchmark only a synthetic empty directory when
   the report concerns a real Project.
2. Establish the baseline with
   `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:startup`. Record the
   `CAXRI_STARTUP_BENCHMARK` object. For editor latency, also run
   `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:editor` and record
   `CAXRI_EDITOR_BENCHMARK`. The editor benchmark runs isolated cold and idle-preloaded launches. It
   defaults to `vitest.config.ts` and `package.json`; for another representative root, set
   `CAXRI_BENCHMARK_EDITOR_FILE`, a visible unique `CAXRI_BENCHMARK_EDITOR_TEXT`, and a root-level
   `CAXRI_BENCHMARK_EDITOR_DETOUR_FILE` that does not contain that text.
   For Renderer re-renders, frame gaps, Long Animation Frames, and interaction latency, run
   `bun run benchmark:renderer` and record `CAXRI_RENDERER_BENCHMARK`. The command owns its isolated
   Project, seeds eight Sessions plus a populated and expanded file tree, uses a profiling React
   build without observer overhead, measures one `session.switch`, and writes
   `test-results/receipts/renderer-performance.json`. Read the fixed `session.select` and
   `app.bootstrap` request summaries before attributing time to React.
   For switching to a long Agent Chat (blank transcript frames, scroll position, re-reads), run
   `bun run benchmark:chat-switch` and record `CAXRI_AGENT_CHAT_SWITCH_BENCHMARK`. It measures a
   kept-alive, an evicted-but-cached, and an uncached Chat frame by frame after paint in a profiling
   build, gates per-surface React budgets, and writes
   `test-results/receipts/agent-chat-session-switch.json`; see
   [Agent Chat Session switch](../../../docs/renderer-performance.md#agent-chat-session-switch).
   For Claude Agent-state probe latency, run `bun run benchmark:agent-probe` and record
   `CAXRI_AGENT_PROBE_BENCHMARK`. It runs below Electron against a synthetic 512-file
   `sessions/` directory and rewrites one file every ten probes; the production `agent.probe` log
   only keeps samples slower than 250ms, so this is the only source of the full distribution. It
   is a trend tool and never fails on its own: a wall-clock threshold passes on an idle machine
   with the cache fully broken. Read the `cache` counters it prints beside the timings to tell a
   fast run from a cache that stopped working, and keep regression protection in the syscall-count
   assertions in `metadata-cache.test.ts` and `probe-fanout.test.ts`.
3. Read the correlated Desktop Main, Server Core, Terminal Host, and Extension Host JSONL logs
   from the active runtime profile's `<userData>/logs/` directory. Use `app.ready`, `app.startup_profile`,
   `server_connection.attached`, `window.ready_to_show`, `server_core.ready`, `pty.spawned`,
   `file.list`, `git.command`, `agent.probe`, `watcher.ready`, `pty.first_input`, and
   `pty.throughput_summary` to locate the owner. Add timing logs at operation boundaries for new
   non-trivial work so regressions remain attributable. Start a live investigation with the
   volume signals before reading individual records: every rotated generation opens with a
   `log.rotated` record whose `generationMs` and `topEvents` name what filled the file, so a
   generation that lasted hours instead of days points at a runaway event. To see where a live
   process spends CPU without relaunching it, sample it over the always-on inspector:
   `bun run .agents/skills/performance/scripts/cpu-profile.ts --port 9229 --seconds 10`
   (9230 Extension Host, 9231 Terminal Host, `--renderer --port 9224` for the packaged Renderer).
4. Preserve privacy: timings, counts, IDs, relative paths, and byte totals are allowed; terminal
   output, source contents, prompts, credentials, environment values, and agent transcripts are
   not.
5. Share concurrent identical expensive operations. Aggregate high-frequency Terminal telemetry
   instead of synchronously logging each input, resize, or output event. Keep editor-only
   dependencies out of the terminal-first Renderer entry. Send live PTY output only to attached
   Renderer views; restore the bounded snapshot before replaying output buffered during attachment.
6. Add a focused unit or integration test for the optimized boundary and extend the performance E2E
   assertion when a regression can be observed there. Keep React render-count and total-duration
   budgets per stable surface. Browser frame, Long Animation Frame, and Event Timing metrics remain
   diagnostic unless a same-runner experiment proves a deterministic budget.
7. Run `bun run check --lint --test --type`, the focused Electron workflow, and the benchmark
   again. Compare like-for-like repository, build mode, and executable. Reserve the full unit and
   E2E suites for release or CI parity.

For an interactive Renderer scenario, follow [Renderer performance observability](../../../docs/renderer-performance.md).
The strict receipt is the source of truth. Start a component-level investigation only when three
exact-head runs identify the same Profiler surface as the regression. Do not rank components by
subtree-inclusive Fiber `actualDuration`; Caxri removed `react-scan/lite` 0.5.7 after its React 19.2
commit trees failed the parent/child duration consistency required to derive self time. Add a future
attribution tool only with bounded, internally consistent output and an avoidable
props/state/context/hook cause.

For launch latency, measure packaged builds with the median runner in
[startup performance](../../../docs/startup-performance.md) and compare `app.startup_profile`
milestones. Read its "Startup design" and "Not applicable" sections before proposing a startup
trick. A sound, low-risk optimization ships even when today's A/B is within noise, since the
startup path keeps growing; reject one only for a measured regression, real risk, or a dev-debugging
cost.

The large-Project startup gate requires Server Core, Terminal, Files, and single- or
multi-repository Git to become usable within three seconds. A performance change must retain that
benchmark assertion or add a focused regression at its owning boundary.

For a packaged application, run:

```bash
CAXRI_BENCHMARK_EXECUTABLE="$PWD/release.noindex/mac-arm64/Caxri.app/Contents/MacOS/Caxri" \
  CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository \
  bunx playwright test e2e/startup.performance.e2e.ts --reporter=line
```

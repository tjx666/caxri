---
name: performance
description: Measure and protect Caxri startup and Runtime responsiveness in large Projects. Use for slow launch or Session restore, repeated Runtime requests, watcher or file-descriptor growth, PTY responsiveness, Git or Agent probe latency, logging overhead, and Renderer bundle regressions.
---

# Measure Caxri Performance

1. Choose a representative large repository. Never benchmark only a synthetic empty directory when the report concerns a real Project.
2. Establish the baseline with `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:startup`. Record the `CAXRI_STARTUP_BENCHMARK` object.
   For editor latency, also run `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:editor` and record `CAXRI_EDITOR_BENCHMARK`.
   The editor benchmark runs isolated cold and idle-preloaded launches. It defaults to `vitest.config.ts` and `package.json`; for another representative root, set `CAXRI_BENCHMARK_EDITOR_FILE`, a visible unique `CAXRI_BENCHMARK_EDITOR_TEXT`, and a root-level `CAXRI_BENCHMARK_EDITOR_DETOUR_FILE` that does not contain that text.
3. Read the correlated Main and Runtime JSONL logs from repository `logs/` during development or the active Electron user-data directory for packaged/test launches. Use `app.ready`, `runtime.attached`, `window.ready_to_show`, `runtime.ready`, `pty.spawned`, `file.list`, `git.command`, `agent.probe`, `watcher.ready`, and `pty.throughput` to locate the owner.
4. Preserve privacy: timings, counts, IDs, relative paths, and byte totals are allowed; terminal output, source contents, prompts, credentials, environment values, and agent transcripts are not.
5. Share concurrent identical expensive operations. Aggregate high-frequency Terminal telemetry instead of synchronously logging each input, resize, or output event. Keep editor-only dependencies out of the terminal-first Renderer entry.
6. Add a focused unit or integration test for the optimized boundary and extend the performance E2E assertion when a regression can be observed there.
7. Run `bun run check --lint --test --type`, the focused Electron workflow, and the benchmark again. Compare like-for-like repository, build mode, and executable. Reserve the full unit and E2E suites for release or CI parity.

For a packaged application, run:

```bash
CAXRI_BENCHMARK_EXECUTABLE="$PWD/release/mac-arm64/Caxri.app/Contents/MacOS/Caxri" \
  CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository \
  bunx playwright test e2e/startup.performance.e2e.ts --reporter=line
```

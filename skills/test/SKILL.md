---
name: test
description: Validate Caxri changes with focused Vitest coverage, real PTY integration, and Playwright Electron end-to-end workflows. Use after implementation, while reproducing regressions, or before declaring a Caxri milestone complete.
---

# Test Caxri

1. Keep unit and integration tests beside their source domain, using `__tests__/` in busy directories, then run the narrowest relevant test with `bunx vitest run --silent='passed-only' <test-file>`.
2. Run `bun run lint` and `bun run typecheck` for every code change.
3. Run `bun run test` for Runtime, persistence, security, configuration, and pure-state coverage.
4. Run `bun run test:e2e` when window lifecycle, IPC, Renderer attach, PTY continuity, recovery, or packaging-facing behavior changes.
5. Run `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/large/repository bun run benchmark:startup` after startup, watcher, Terminal, file, Git, Agent, logging, or Renderer-bundle changes.
6. Preserve privacy in fixtures: never place real tokens, user code, transcripts, or production paths in test artifacts.
7. Report exact commands, pass/fail counts, and benchmark timings. Do not weaken assertions or disable tests to manufacture a pass.

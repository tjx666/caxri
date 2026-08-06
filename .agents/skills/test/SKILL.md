---
name: test
description: Validate Caxri changes with focused Vitest coverage, real PTY integration, and Playwright Electron end-to-end workflows. Use after implementation, while reproducing regressions, or before declaring a Caxri milestone complete.
---

# Test Caxri

1. Keep unit and integration tests beside their source domain, using `__tests__/` in busy directories, then run the narrowest relevant test with `bunx vitest run --silent='passed-only' <test-file>`.
2. Use the `quality-check` skill or run `bun run check <changed-files> --lint --test --type` for the default post-edit gate.
3. Run focused Vitest files for Runtime, persistence, security, configuration, and pure-state coverage.
4. Do not unit-test React components by default. When component logic is worth testing, extract it into a hook or pure function and test that; leave rendering and interaction to the smallest relevant E2E workflow.
5. Every bug fix must land with a behavior-level regression test that fails before the fix and passes after it.
6. Run focused Playwright Electron coverage when window lifecycle, IPC, Renderer attach, PTY continuity, recovery, or packaging-facing behavior changes.
7. Run `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/large/repository bun run benchmark:startup` after startup, watcher, Terminal, file, Git, Agent, logging, or Renderer-bundle changes.
8. Preserve privacy in fixtures: never place real tokens, user code, transcripts, or production paths in test artifacts.
9. Run the full unit or E2E suite only for release or CI parity, when explicitly requested, or when a shared cross-cutting contract makes focused coverage insufficient. Report exact commands, pass/fail counts, and benchmark timings. Do not weaken assertions or disable tests to manufacture a pass.

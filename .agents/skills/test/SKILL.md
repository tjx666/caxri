---
name: test
description: Validate Caxri changes with focused Vitest coverage, real PTY integration, focused Playwright Electron workflows, and remote full-suite validation through pull-request CI. Use after implementation, while reproducing regressions, or before declaring a Caxri milestone complete.
---

# Test Caxri

1. Keep unit and integration tests beside their source domain, using `__tests__/` in busy directories, then run the narrowest relevant test with `bunx vitest run --silent='passed-only' <test-file>`.
2. Use the `quality-check` skill or run `bun run check <changed-files> --lint --test --type` for the default post-edit gate.
3. Run focused Vitest files for Runtime, persistence, security, configuration, and pure-state coverage.
4. Do not unit-test React components by default. When component logic is worth testing, extract it into a hook or pure function and test that; leave rendering and interaction to the smallest relevant E2E workflow.
5. Every bug fix must land with a behavior-level regression test that fails before the fix and passes after it.
6. Run focused Playwright Electron coverage when window lifecycle, IPC, Renderer attach, PTY continuity, recovery, or packaging-facing behavior changes.
7. Run `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/large/repository bun run benchmark:startup` after performance-sensitive initialization, watcher, PTY, file, Git, Agent, logging, or Renderer entry/lazy-loading changes. Skip it for pure style, copy, theme-token, or layout changes unless they alter startup measurement or Terminal fitting behavior.
8. Preserve privacy in fixtures: never place real tokens, user code, transcripts, or production paths in test artifacts.
9. Never run the full E2E suite locally during an ordinary run. When development requires full-suite coverage, follow the remote pull-request workflow below. The only exception is the guarded Go fallback below. Run the full unit suite locally only when explicitly requested or when a shared cross-cutting contract makes focused coverage insufficient. Report exact commands, pass/fail counts, and benchmark timings. Do not weaken assertions or disable tests to manufacture a pass.

## Electron error gate

- Import `test` and `expect` from `e2e/fixtures.ts`. Its automatic fixture registers every
  `launchCaxri*` application, observes current and future Renderer pages, and parses the structured
  Main/Runtime logs after close.
- Unexpected Renderer exceptions/console errors and Main/Runtime error or fatal events fail even
  when the user workflow otherwise passes. A deliberate fault must use `allowE2EErrors(...)` with
  an exact `source`, `event`, `code`, and positive `count`; a missing event or stale allowance also
  fails. Never allow by message substring or wildcard.
- The launch boundary captures and attaches `main.jsonl` and `runtime.jsonl` before a spec removes
  its temporary user-data directory. Keep error diagnostics content-free: no source, Terminal
  output/snapshots, Agent prompts/responses/transcripts, environment, or credentials.

## Agent launch modes

- Ordinary E2E launches are `blocked` and use provider state beneath the isolated test user-data
  directory. Any spec that creates an Agent Terminal must explicitly pass either
  `createFakeAgentMode(...)` or `{ mode: 'real', provider: '<provider>' }`; a negative test that
  proves unavailable or blocked behavior may explicitly use `blocked` or exercise the default.
- Use `createFakeAgentMode(...)` for deterministic output, metadata, lifecycle, byte-input, and
  control-input coverage. Do not discover a fake by prepending `PATH`; pass its absolute executable
  through the fixture contract.
- `bun run test:e2e:real-agent` is a manual Codex-only smoke. It requires an authenticated CLI,
  disables screenshots and traces, sends one bounded natural read-only prompt in a temporary
  Project, and must fail clearly instead of falling back to another provider.

## Remote full E2E during development

Use this workflow only when focused E2E coverage is insufficient:

1. Move the work off `main` before committing. If the changes are still uncommitted on `main`, preserve them with `git switch -c <topic-branch>`; otherwise continue on the existing non-`main` branch.
2. Finish the implementation and focused local validation. Do not run the full Electron suite locally.
3. Commit the change with an English subject. Before the first remote mutation, confirm that the user authorized PR delivery or explicitly ask for permission to push the branch and create a draft PR.
4. Push the current branch with `git push -u origin HEAD`, then create a draft PR with `gh pr create --draft --base main --fill`. A draft PR is sufficient to trigger `.github/workflows/ci.yml` through its `pull_request` event.
5. Wait for the remote checks with `gh pr checks --watch --fail-fast`. The Ubuntu `checks` job
   owns platform-neutral gates; the macOS `e2e` job runs `bun run test:e2e` only after those checks
   succeed.
6. If CI fails, inspect the failing job with `gh run view <run-id> --log-failed`, fix the same branch, push again, and wait for the replacement checks. Never weaken or skip the suite to obtain a pass.
7. Report the PR and workflow links plus the final checks and E2E conclusions. Do not merge or close the PR unless the user authorized that action.

## Guarded local fallback for external CI failure

Use this exception only inside an explicit Go run. The `$go` invocation alone
automatically authorizes only a verified zero-step GitHub Actions payment or
spending-limit failure. Before running any fallback command, verify and record:

1. The current PR head and a hosted Actions job for that head whose step count
   is zero because of external billing or infrastructure failure.
2. The workflow URL, job name, failure classification, and external failure
   detail. For automatic billing authorization, preserve the original GitHub
   payment, billing, or spending-limit error text. An ordinary code or test
   failure is ineligible.
3. The project-policy authorization for a payment or spending-limit failure, or
   separate explicit user authorization for another infrastructure failure.
4. A clean worktree at the recorded PR head, an explicit exact-head review
   freeze, and an admitted fallback in the Go ledger. If the head changes,
   discard the freeze and admission and return to focused validation and remote
   CI.

Run the platform-neutral CI commands from `.github/workflows/ci.yml` in their
declared order, then run `bun run test:e2e` exactly once against the same
isolated head. Record every command and its result through the Go ledger. Any
failure blocks delivery and routes back to normal repair; never re-admit the
same head. Push a repaired head and wait for its new hosted run before another
fallback can be considered. Normally a Go run gets one full Electron E2E; a
product failure or human Acceptance rejection may permit one final exact-head
rerun after focused repair and a new review freeze. The ledger rejects a third
full run and rejects repetition after a passing run without human rejection. Do
not include release packaging or deployment, do not use the fallback without
authorization, and do not change the hosted check from externally failed to
green.

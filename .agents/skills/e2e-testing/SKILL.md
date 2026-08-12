---
name: e2e-testing
description: Validate Caxri through focused Playwright Electron workflows, real PTY and IPC boundaries, native window lifecycle, E2E fixtures, production-build parity, error artifacts, and hosted full-suite CI. Use after changing user-visible Electron behavior, E2E infrastructure, Agent launch fixtures, desktop leases, or packaging-facing runtime behavior; when diagnosing a hosted-only Electron failure; or when an explicit Go run needs its guarded exact-head fallback. Do not use as the default Vitest workflow.
---

# E2E Testing

Use the smallest real Electron workflow that proves the changed boundary.

## Focused workflow

1. Finish source edits and focused `unit-test` coverage first when both layers apply.
2. Rebuild after relevant `src/` changes, then run only the owning spec and test name:

   ```bash
   bun run build
   bunx playwright test <e2e-file> -g '<test name>' --reporter=line
   ```

3. Every spec imports `test` and `expect` from `e2e/fixtures.ts`. The automatic error gate observes
   current and future Renderer pages, structured Main/Runtime errors, and attaches content-free logs
   before temporary profiles disappear.
4. Focused launches use hidden windows. Use `windowMode: 'visible'` only for native focus or pointer
   behavior. Every launch acquires the repository-wide desktop lease through `e2e/helpers.ts`.
5. Ordinary launches use blocked Agent discovery. Agent specs explicitly choose a shared fake mode
   or the manual Codex-only real smoke; never inherit host Agent state by accident.
6. A deliberate error must consume one exact `allowE2EErrors(...)` tuple. Wildcards, message
   matching, duplicate allowances, or unused allowances fail the spec.

## Readiness and failure-isolation contracts

- Use `createProjectSession` / `waitForCreatedSession` so dialog removal, selected Session,
  durable Session/Terminal state, visible Session card, and focused Terminal converge together.
- A fake Agent publishes its ready marker only after raw mode and input capture are installed. Wait
  for that marker before sending bytes; never use a sleep as readiness.
- For Terminal resizing, wait for repeated identical guest/Runtime grid observations and compare
  them with the rendered xterm grid. Extra intermediate `SIGWINCH` values are valid.
- Treat only an expected transient filesystem `ENOENT` as pending. Propagate permission, malformed
  data, and other IO errors immediately.
- Match Terminal text across rendered rows when long CI paths or narrow panes can wrap it. Do not
  assume a logical token belongs to one DOM row.
- Publish repository and desktop ownership only after complete owner metadata is durable. Await
  launch finalization and lease cleanup so one worker failure cannot poison later specs.
- Preserve the first causal failure and its artifacts. Do not use retries to turn an original red
  result green or allow a lock/lease cascade to hide it.

## Hosted-only parity

Reproduce only the exact failed cases against the production build with one worker and three
deterministic repetitions:

```bash
bun run build
bunx playwright test <failed-files...> -g '<failed test>' --workers=1 --repeat-each=3 --reporter=line
```

Preserve the relevant CI viewport, font/locale/shell behavior, and long temporary-path conditions.
Inject slowness at the owning async boundary or wait for an observable product invariant. Never use
machine-wide throttling, fixed sleeps, random pressure, or a timeout-only change as the fix.

CI retains screenshots, traces, the final viewport/grid, fixture ready markers, and content-free
Main/Runtime logs for failures. Keep the failed hosted run red while diagnosing it.

## Controlled PR retries

For a new repair commit after a base run's Linux `checks` passed and macOS `e2e` failed, first run
the complete platform-neutral command sequence from `.github/workflows/ci.yml` on the clean commit.
Then amend only commit metadata with this immutable receipt, using the exact tree printed before the
amend:

```text
CI-Mode: e2e-only
CI-Base-Run: <failed-run-id>
CI-Validated-Tree: <git rev-parse HEAD^{tree}>
```

Use `CI-Mode: e2e-repair` plus one `CI-E2E-Tests: ["e2e/example.e2e.ts"]` JSON trailer when one or
more named specs should fail fast before the complete E2E suite. The CI policy admits the shortcut
only for the same PR, base SHA, workflow, ancestor head, and exact tree; malformed, stale, missing,
or protected-configuration evidence falls back to full CI. A focused pass is diagnostic only and
always continues to the complete suite on the same macOS runner. For the same SHA, prefer
`gh run rerun <run-id> --failed` without adding trailers.

## Remote full suite

Never run `bun run test:e2e` locally during an ordinary run. When focused coverage is insufficient,
use an authorized topic branch and draft PR; GitHub Actions runs platform-neutral checks first and
the macOS full Electron suite on the exact PR head. Inspect failures, repair the same branch, and
wait for replacement checks. Do not merge or close without delivery authorization.

## Guarded Go fallback

Use a local full suite only inside an explicit Go run after a current-head hosted job is verified to
have failed before runner allocation for an eligible external billing or infrastructure reason. The
Go ledger must record the exact frozen head, failure URL/job/detail, authorization, platform-neutral
commands, and one `bun run test:e2e` result. A changed head invalidates the admission. Code/test
failures, missing authorization, releases, and deployment are never eligible, and the hosted check
remains externally failed rather than being relabeled green.

---
name: e2e-testing
description: Validate Caxri through focused Playwright Electron workflows, real PTY and IPC boundaries, native window lifecycle, E2E fixtures, production-build parity, error artifacts, and self-hosted full-suite CI. Use after changing user-visible Electron behavior, E2E infrastructure, Agent launch fixtures, desktop leases, or packaging-facing runtime behavior; when diagnosing a CI-only Electron failure; or when an explicit Go run needs its guarded exact-head fallback. Do not use as the default Vitest workflow.
---

# E2E Testing

Use the smallest real Electron workflow that proves the changed boundary.

## Focused workflow

1. Finish source edits and focused `unit-test` coverage first when both layers apply.
2. Run only the owning spec and test name through the compact checker; it rebuilds first so the
   Electron launch cannot exercise stale output:

   ```bash
   bun run --silent check <e2e-file> --e2e --e2e-grep '<test name>'
   ```

3. Every spec imports `test` and `expect` from `e2e/support/fixtures.ts`. The automatic error gate observes
   current and future Renderer pages, structured Main/Runtime errors, and attaches content-free logs
   before temporary profiles disappear.
4. Focused launches use hidden windows. Use `windowMode: 'visible'` only for native focus or pointer
   behavior. Every launch acquires the repository-wide desktop lease through `e2e/support/helpers.ts`.
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
- CI keeps `maxFailures` for fast containment, then reruns only suppressed tests one at a time. The
  final pool receipt must classify every planned spec as `pass`, `fail`, or `timeout`, retain
  per-test artifacts, and group repeated failures by stable error identity before repair begins.

## CI-only parity

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
Main/Runtime logs for failures. Keep the failed CI run red while diagnosing it.

If the failed logical pool was `parallel-safe`, the serial repetitions are necessary but not
sufficient. Run the exact failed specs again under the repository-owned namespaced two-worker pool,
because loaded-runner races can expose stale async state and hidden warmup surfaces that one worker
cannot reproduce. Prefer stable observable locators and explicit busy-to-ready transitions over
arbitrary delays.

Issue #116 CI evidence uses the repository-owned workflow dispatch instead of an ad-hoc command:

- `e2e_profile=control` runs the exact full manifest with one worker.
- `e2e_profile=optimized` runs the explicit `parallelSafeSpecs` allowlist with two workers, then
  the fail-closed `desktop-exclusive` remainder with one worker in the same E2E job. Move
  individually audited safe tests into a dedicated allowlisted spec instead of splitting one spec
  across pools.
- Both profiles install and build once. The optimized job attempts both logical pools after a pool
  failure, publishes an actual-execution receipt and per-pool artifacts, and workflow dispatches
  run the deterministic CI-parity cases through `scripts/run-ci-parity.ts`.
- Run each profile until it has three consecutive green samples on the same Node/pnpm/lockfile,
  runner label, test manifest, and workflow parameters. Record every non-green attempt.
- Adopt optimized only when it preserves isolation and test counts and improves median feedback.
  Otherwise restore one worker and publish the reject decision.

## Controlled PR retries

For a new repair commit after a base run's `checks` passed and `e2e` failed, first run the complete
platform-check command sequence from `.github/workflows/ci.yml` on the clean commit.
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

Do not push one repair per observed assertion. Download the original failure artifacts, inspect the
whole failed spec and its async/locator assumptions, finish the repair batch locally, then create one
new CI head. When protected workflow, dependency, fixture, pool, or retry-policy files changed,
the shortcut intentionally falls back to full CI; treat that as a reason to converge locally before
pushing, never as a reason to iterate through full runs.

## Remote full suite

Never run `bun run test:e2e` locally during an ordinary run. When focused coverage is insufficient,
use an authorized topic branch and draft PR; GitHub Actions runs checks and the full Electron suite
on the repository self-hosted `m2-24` runner. Inspect failures, repair the same branch, and wait for
replacement checks. Do not merge or close without delivery authorization.

## Guarded Go fallback

Use a local full-suite substitution only inside an explicit Go run after a current-head self-hosted
Actions job is verified to have failed before execution for an eligible external GitHub Actions
infrastructure reason and the user separately authorizes the substitution. The Go ledger must
record the exact frozen head, failure URL/job/detail, authorization, platform-check commands, and
one `bun run test:e2e` result. A changed head invalidates the admission. Code/test failures, missing
authorization, releases, and deployment are never eligible, and the Actions check remains
externally failed rather than being relabeled green.

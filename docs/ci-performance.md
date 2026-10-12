---
kind: living
status: current
---

# CI and E2E Performance Evidence

This is the single source of truth for CI optimization decisions, execution profiles, and
performance evidence. It preserves historical GitHub-hosted evidence and records current
self-hosted samples, non-green attempts, correctness constraints, and resource controls. A failed
path is useful failure-cost data, but it is never a green performance baseline. Runner labels,
trust, offline behavior, and recovery are owned by
[`docs/self-hosted-runner.md`](self-hosted-runner.md).

## Baseline

[Run 31581073589](https://github.com/tjx666/caxri/actions/runs/31581073589) uses exact head
`4ec56415a2c99b91418c6deff1754ddce3a0a2bd` and the pre-optimization workflow. Its E2E manifest is
94 tests: 91 passed and 3 skipped in the original attempt.

| Attempt | `checks` |   `e2e` | Linux `npm ci` | ESLint | Vitest | macOS `npm ci` | Playwright | Result                                      |
| ------- | -------: | ------: | -------------: | -----: | -----: | -------------: | ---------: | ------------------------------------------- |
| 1       |     3:35 |    9:44 |           0:48 |   0:49 |   0:59 |           0:43 |       8:46 | green                                       |
| 2       |     3:28 |    7:52 |           0:46 |   0:45 |   0:59 |           0:44 |       6:49 | green                                       |
| 3       |     3:20 | skipped |           None |   None | failed |           None |       None | late copy-timeout rejection                 |
| 4       |     3:12 | skipped |           None |   None | failed |           None |       None | same rejection plus hosted worktree timeout |
| 5       |     3:40 | skipped |           None |   None | failed |           None |       None | late copy-timeout rejection                 |

The two green E2E jobs vary by almost two minutes on the same head, so one hosted sample is not a
trend. Attempts 3–5 also show that a nominal rerun is not evidence when the same deterministic race
remains red.

This table is a historical npm baseline. The pnpm 12 and Node 24 migration changes toolchain setup,
install, and cache semantics, so it must not be used as a same-environment comparison for current
CI; record a new exact-head self-hosted baseline before making further install-time claims.

### Single-runner concurrent-window baseline

[Run 34601568589](https://github.com/tjx666/caxri/actions/runs/34601568589) is a full optimized
ready-PR run on `m2-24`. Its `e2e` job took 15m43s end to end, and the concurrent validation window
(`ci-concurrent-validation.ts run`) accounted for 14m51s of that. The `CAXRI_CI_METRIC` lines split
that window into two branches:

- Exact-head E2E, 889s: build 22s, native modules 2s, interruption recovery 8s, `parallel-safe`
  274s, `desktop-exclusive` 582s.
- Synthetic-merge platform gates, 664s: ESLint 276s, oxlint 17s, Vitest 336s, bundle budget 29s.

E2E is therefore the critical path, and the platform gates finish 2m41s earlier. Shortening them
cannot shorten the run while E2E is longer, so the `desktop-exclusive` pool is what to reduce
first. What their duration does decide is where their CPU demand lands, which is a separate
question with its own answer below.

### Keep the checks branch out of the three-worker window

The two pools absorb CPU contention very differently. The one-worker `desktop-exclusive` pool leaves
most of the machine idle and barely competes with the checks branch. The three-worker `parallel-safe`
pool is already using the runner, so every core the checks take is one its Electron workers wanted,
and a stalled Renderer there does not merely run slower: an interaction that races an asynchronous
re-render starts losing it, which is a flaky test rather than a slow one.

[Run 35553657625](https://github.com/tjx666/caxri/actions/runs/35553657625) is the first run where
that window got large. `desktop-exclusive` ended at 02:26:49 and the checks branch ran until
02:32:47, so 358s of the 452s three-worker pool (79% of it) ran under full contention. Three
specs failed that no change in that run had touched: `git-diff-tabs` (Monaco diff never mounted
after the click), `terminal-commands` (a split remount that never reset its command tracker), and
`toasts` (a toast dismiss button that never appeared). All three pass two deterministic local
repetitions at one worker. They are tracked as load-sensitive cases in
[issue #1418](https://github.com/tjx666/caxri/issues/1418).

This is a plausible cause rather than a proven one: the same run also added `agent-delegation` to
the pool, which raises in-pool CPU load by itself, and an earlier green run overlapped its
three-worker pool with the checks branch completely. What both explanations share is CPU saturation
during `parallel-safe`, so that is what the concurrent path reduces: Vitest runs with two workers
there, matching the standalone checks job. Total CPU work is unchanged: a one-worker Vitest spreads
the same work across a longer window, and the window is what reaches into the fragile pool. The
extra worker lands during `desktop-exclusive`, which has the headroom for it.

Treat this as a preference whenever a pool gets faster: **as little of `parallel-safe` as possible
should overlap the checks branch.** Shorten the checks branch to reduce the overlap; never slow E2E
back down. It is no longer a hard rule: once the exclusive pool shrank below the checks branch
([Default to the parallel pool](#default-to-the-parallel-pool)), keeping zero overlap would have meant
idling the runner, and the deadline below cannot afford that. A manual `workflow_dispatch` defaults
`vitest_max_workers` to the same two workers: a one-worker default once stretched the checks branch
about 6 minutes into `parallel-safe` and pushed the run past the 25-minute concurrent-validation
deadline ([issue #1842](https://github.com/tjx666/caxri/issues/1842)).

### Per-spec attribution

Every pool receipt carries `durationMs` on each test and each spec, and the pool's step summary
prints the ten costliest specs with their share of the pool's serial total. Read that before
proposing any pool change; it is the intended input for deciding what to move, split, or shorten.

The share is against the pool's **serial** total, not its wall time. On a multi-worker pool those
differ on purpose: the serial total is the work, the wall time is what the workers achieved with it.
Moving a spec between pools changes the serial total, so that is the number to reason with. The two
together also measure the pool itself: serial ÷ wall is how many workers were actually busy, which
is the only honest input for changing the worker count.

Receipt paths are repository-relative, and `assertE2EPoolReceipt` rejects an absolute one. A receipt
is an uploaded artifact whose spec paths reach the public step summary, so an absolute path there
would publish the runner's home directory and the account name inside it.

Before the receipt recorded durations, attribution meant reading the job log, and that method is
worth knowing because it is the only way to re-derive a historical run. The `line` reporter prints
`[N/M] spec:line › title` when a test **begins**, so a test's duration is the gap to the _next_
line, not the gap from the previous one. Reading it the other way shifts every duration by one test
and blames the wrong spec: it attributed 125s to `logs-panel.e2e.ts` when the cost belonged to
`hook-turn-recovery.e2e.ts`. It also only works on a one-worker pool: with three workers the lines
interleave and no per-test duration can be recovered from begin timestamps alone. That limitation is
exactly why the duration belongs on the receipt instead.

### Long fixed waits are the first thing to look for

[Run 35542871828](https://github.com/tjx666/caxri/actions/runs/35542871828) measured a 22m20s `e2e`
job whose `desktop-exclusive` pool took 892s of the 1235s critical path. Two tests held 203s of it,
both waiting out a production timer rather than doing work:

- `hook-turn-recovery.e2e.ts` spent 125s letting the two-minute quiet-hook-turn recovery window
  elapse in real time.
- `pr-unknown.e2e.ts` spent 63s of its 78s letting the status bar's one-minute pull-request poll
  come around again.

Both were replaced with the repository's established fix for this shape: a bounded, `CAXRI_E2E=1`
gated environment seam that only ever shortens the production value, with the production constant
pinned by a fast unit test so the seam cannot quietly become the contract.
`CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS` (1s–30s, resolved in
`apps/server/src/domains/agents/e2e-options.ts`) and `CAXRI_E2E_MAX_POLL_INTERVAL_MS` (1s–30s,
resolved in `apps/desktop/src/renderer/src/lib/poll-scheduler.ts`, which caps every registered
Renderer poll) cut the two specs to 11.5s and 16.2s locally with no change to their assertions.
Both resolvers fail closed on a value outside their bound, and the poll cap only lowers a cadence,
so a spec asserting a fast tick is unaffected whether or not its launch opts in.

After that repair the exclusive pool has no outlier left (it is a flat tail of 3–30s specs) so the
remaining lever is moving work out of it rather than making individual tests faster.

### Auditing the exclusive pool for admission

Screening the same run's 65 exclusive specs against the admission conditions of the then-current allowlist left 26 with
no mechanical disqualifier; reading those individually admitted 17, worth about 146s of one-worker
time, and moved the split from 71/65 to 88/48. The rejections are the useful part of the record:

- `logs-panel.e2e.ts` asserts its own query cadence in real milliseconds, which is a wall-clock
  assertion however fast the machine is.
- `menu-keybinding-recovery.e2e.ts` reads the installed native application menu.
- `agent-delegation.e2e.ts` (the single largest spec at 95s) drives the CLI through a `spawnSync`
  with a 25-second timeout, which is exactly the "subprocess whose timeout has little headroom" the
  admission conditions exclude. **Later admitted**: see the round-two note below.
- `codex-compaction.e2e.ts`, `updates.e2e.ts`, and `workbench-root.e2e.ts` pass the mechanical
  screen but are named in `scripts/__tests__/e2e-pools.test.ts`'s guard list. That list is a
  recorded prior audit; reaching the opposite conclusion about one of its entries is a product
  decision, not a reclassification, so they stayed exclusive.

### A screen is not an audit

The mechanical screen above matched keywords in spec sources, and keyword matches produce false
positives: it flagged `session-create-menu.e2e.ts` for "menu" when that spec touches no native menu,
and flagged several specs for "clipboard" that only mention the word. Re-screening against the
declared capability instead of the source text recovered roughly 100s of specs that were never
actually disqualified: worth remembering the next time a screen is mistaken for a verdict.

That re-screen also surfaced a real defect. A separate hand-maintained list was what kept a
clipboard-requesting spec out of the parallel pool, and it had fallen three entries behind the specs
themselves (`editor-git-actions`, `file-preview`, `project-path-actions` all pass `clipboard: true`
while unlisted). A stale entry there fails nothing on its own; it just silently stops protecting the
spec it forgot. `scripts/__tests__/e2e-pools.test.ts` now derives the set from the spec sources and
fails when `desktopExclusiveSpecs` disagrees.

`agent-delegation.e2e.ts` was readmitted on the same principle. The condition excludes a subprocess
timeout with little headroom, and its synthetic CLI allowed `spawnSync` only 5 seconds beyond the
20-second wait it was invoking. That missing margin was a defect in the spec, not a property of what
it tests, so the fix is to give the subprocess enough (45s) rather than to keep the largest spec in
the pool on one worker forever. Under three workers it passes alongside `work-tab-sizing` and
`terminal-recovery`: 24 tests in 1.3m.

### The 25-minute concurrent-validation budget

`scheduleConcurrentValidationDeadline` in `scripts/ci-concurrent-validation.ts` aborts the whole
window 25 minutes after `execute()` starts, so the clock includes the checks worktree install, the
Electron build, native verification, interruption recovery, and the failure census before either
pool runs (about 45s on `m2-24`). On the E2E branch the window then holds `desktop-exclusive`, the
dispatch-only CI parity cases (about 200s, one worker), `parallel-safe`, and the manifest. The
target is 85% of the deadline (21m15s), which leaves room for one slow pool without a red run.

The window's floor is set by the checks branch, not by E2E alone. ESLint, oxlint, Vitest, and the
bundle budget finished about 15 minutes in on
[run 38197586711](https://github.com/tjx666/caxri/actions/runs/38197586711), and the three-worker
pool cannot run at full speed until they do. Once `desktop-exclusive` is shorter than that branch,
moving more specs out of it saves only about 40% of each moved second, because the moved work lands
in the contended part of the three-worker pool.

### Default to the parallel pool

Before [issue #1846](https://github.com/tjx666/caxri/issues/1846), `e2e/support/pools.ts` admitted a
spec to `parallel-safe` only through an audited allowlist, so every new spec joined the one-worker
pool. It grew from 137 to 155 tests within a few days; a dispatch run then needed about 27m50s and
the nightly about 24.5 minutes. The default is now inverted: `desktopExclusiveSpecs` lists every
spec that keeps the exclusive pool, each with a closed reason (`clipboard`, `visible-window`, `gpu`,
`window-focus`, `wall-clock`, `load-sensitive`, `machine-process`, `native-menu`,
`screen-capture`, `benchmark`, `opt-in-only`) and the concrete evidence, and every unlisted spec runs
on three workers. Two guards keep the default from admitting a spec that cannot share the runner:

- `scripts/__tests__/e2e-pools.test.ts` derives `clipboard: true`, `windowMode: 'visible'`, and
  `gpuMode: 'enabled'` from the spec sources and requires the list to match in both directions, so
  neither a missing entry nor a stale reason survives. It also pins specs that a prior audit
  rejected.
- The launch helper refuses `clipboard`, a visible window, and an enabled GPU inside the parallel
  pool (`e2e/support/worker-isolation.ts`), so a forgotten entry fails on its first run rather than
  as an intermittent failure.

The audit that inverted the default read all 92 exclusive specs. It moved 45 of them, 68 tests and
416s of one-worker time measured on run 38197586711, leaving 48 exclusive specs (about 545s). Two
specs moved only after a repair: `project-status.e2e.ts` widened its fake CLI's 0.4s busy window to
2s, and `agent-commander.e2e.ts` moved its two Workbench hand-off tests into
`agent-commander-workbench-handoff.e2e.ts`, because `focusMainWindow()` then showed the Workbench and
stole OS focus even in a hidden launch. Once a hidden launch's `focusMainWindow()` only focused the
Workbench web contents (`bringWindowForward` in `apps/desktop/src/main/window-mode.ts`), that spec
joined `parallel-safe` too. Rejections worth not repeating: `agent-chat-selection` and
`session-compaction` must observe a 4s toast before it dismisses itself, `session-rename-pending`
races a fake Agent's real 4s timer, `editor-fold-on-open` drives a Monaco `cmd+k` chord,
`session-title-scroll` samples marquee speed with `performance.now()`, and `agent-chat` asserts an
approval round trip finishes within one second. Specs that use `clickTerminalLink` remain admissible
because that helper re-arms a modifier a sibling window's focus dropped.

CI parity also moved: it now runs between the two pools instead of after `parallel-safe`, so its
one-worker cost lands in the window the checks branch already occupies.

## Adopted optimization evidence

The historical optimized workflow rebuilt only `better-sqlite3` and `node-pty`;
`@parcel/watcher` used its Node-API platform package and remained covered by `spike:native`. It kept
the full Vitest manifest while replacing production-sized waits and buffers with injected test
seams. At the time, Playwright was split into separate `parallel-safe` and `desktop-exclusive`
matrix jobs. Those jobs did not run concurrently after CI moved to the single physical `m2-24`;
the runner queued them serially and each job repeated setup and build.

| Evidence                                                                         | Exact head | Result                                                                               |
| -------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| [Control run](https://github.com/tjx666/caxri/actions/runs/31661533997)          | `953c800`  | 99 passed, 5 skipped; one-worker suite 6.5m                                          |
| [Split experiment](https://github.com/tjx666/caxri/actions/runs/31663039930)     | `31dfe0e`  | 41 parallel-safe tests in 1.8m; 58 passed and 5 skipped exclusive tests in 4.3m      |
| [Exact-head dispatch](https://github.com/tjx666/caxri/actions/runs/31663792074)  | `544c775`  | all gates green; 41 tests in 2.1m and 58 passed/5 skipped in 5.4m                    |
| [Ready PR failure](https://github.com/tjx666/caxri/actions/runs/31664514393)     | `544c775`  | exposed a stale path-browser query wait; exclusive pool green                        |
| [Ready PR failure](https://github.com/tjx666/caxri/actions/runs/31665289454)     | `379ed75`  | exposed an ambiguous Monaco warmup locator; exclusive pool green                     |
| [Draft focused checks](https://github.com/tjx666/caxri/actions/runs/31667490248) | `7a0a836`  | runner allocation restored; focused source checks green, macOS intentionally skipped |
| [Final ready PR](https://github.com/tjx666/caxri/actions/runs/31668179503)       | `44e7801`  | all gates green; checks 2.3m, parallel-safe 4.3m, desktop-exclusive 6.9m             |

Hosted native rebuild dropped from roughly 30 seconds to 4–10 seconds depending on the runner.
The original full Vitest suite took 64.95 seconds; optimized exact-head runs measured 57.24 seconds
on a noisy hosted runner and about 30 seconds locally. The largest deterministic file reductions
were terminal integration from 9.913 seconds to 0.907 seconds and Acceptance publication from
2.168 seconds to 0.132 seconds.

Renderer build output remains 4,201 modules and is dominated by Monaco. Identical graphs have ranged
from about 6 to 17 seconds on hosted runners while the current local build is about 2.3 seconds.
`npm dedupe --dry-run` found no useful dependency reduction. Cross-job output caching is not adopted:
checks may build a synthetic PR merge while E2E intentionally verifies the exact pushed head, and
Vite's `.vite` directory is not a reusable production-output cache.

## Self-hosted diagnosis contract

- Runner availability, offline queuing, and recovery follow
  [`docs/self-hosted-runner.md`](self-hosted-runner.md); a queued job is not successful evidence.
- Preserve the first red self-hosted run and download its artifacts. Do not rerun a known red SHA or push
  one assertion fix at a time.
- Reproduce the exact failed spec against a fresh production build with one worker and
  `--repeat-each=3`. A `parallel-safe` failure must also be exercised under its namespaced
  multi-worker pool (CI runs three workers by default; `CAXRI_E2E_PARALLEL_WORKERS` accepts 2 to 4)
  so local validation matches CI scheduling pressure.
- Finish the complete repair batch and focused local gates before pushing once. Use `e2e-repair`
  only when the repair delta modifies existing top-level E2E specs and nothing else. Product,
  workflow, dependency, pool, fixture, shared E2E support, spec-add/delete, and retry-policy changes
  remain fail-closed and require one final full run.
- After one ready-PR run has full checks, every E2E pool, and `CI gate` green, a later strict
  ancestor may reuse that macOS evidence only when its entire delta is documentation or the
  repository-owned `acceptance`/`go` skill. The current head still runs focused self-hosted checks;
  product, workflow, dependency, fixture, pool, and other skill changes fail closed to full CI.
- Keep test counts, assertions, isolation, error gates, and failure artifacts unchanged. Optimize
  fixture cost and orchestration rather than coverage.

## Current CI decision matrix

The policy evaluates a retry hint first, derives the initial execution plan, and only searches for
a reusable ancestor run when an otherwise full ready-PR path needs E2E and has no retry hint or
parse error. A verified ancestor then recomputes the plan. Missing, malformed, stale, or unverifiable
evidence fails closed to the event's ordinary row.

`focused-e2e` runs changed-spec lint and type validation only. Playwright owns the behavioral test;
this path does not invoke Vitest for an E2E-only repair.

`mode` belongs to `RetryPolicyDecision`; the remaining three values belong to
`CIExecutionPlan`. The table is a behavior map, not a second implementation of the state machine.

| Input and validated precondition                                                       | `mode`       | `checksScope`               | `e2eProfile`                        | `runE2E`       |
| -------------------------------------------------------------------------------------- | ------------ | --------------------------- | ----------------------------------- | -------------- |
| Eligible unchanged-tree PR retry                                                       | `e2e-only`   | `skipped`                   | `control`                           | yes            |
| Eligible modified-existing-spec-only repair                                            | `e2e-repair` | `focused-e2e`               | `focused`                           | yes            |
| Product, shared E2E support, protected, unknown, or spec-add/delete repair delta       | `full`       | Continue with the event row | Continue with the event row         | event row      |
| Missing or rejected retry evidence                                                     | `full`       | Continue with the event row | Continue with the event row         | event row      |
| `workflow_dispatch`, profile `skip` / `control` / `optimized`                          | `full`       | `full`                      | `control` / `control` / `optimized` | no / yes / yes |
| PR strict-ancestor full-green reuse; delta is documentation only                       | `full`       | `focused-docs`              | `control`                           | no             |
| PR strict-ancestor full-green reuse; delta includes only `go` / `acceptance` skills    | `full`       | `focused-skills`            | `control`                           | no             |
| PR documentation only                                                                  | `full`       | `focused-docs`              | `control`                           | no             |
| PR repository-skill and documentation only                                             | `full`       | `focused-skills`            | `control`                           | no             |
| Draft PR with any remaining source change                                              | `full`       | `focused-source`            | `control`                           | no             |
| Ready PR whose delta touches a full-validation path or has a malformed E2E declaration | `full`       | `full`                      | `optimized`                         | yes            |
| Ready PR with any remaining source change                                              | `full`       | `affected`                  | `focused`                           | yes            |
| `schedule` (nightly) whose head differs from the previous completed nightly            | `full`       | `full`                      | `optimized`                         | yes            |
| `schedule` (nightly) whose head equals the previous completed nightly                  | `full`       | `skipped`                   | `control`                           | no             |
| Non-release `push` containing only documentation or repository skills                  | `full`       | `full`                      | `optimized`                         | no             |
| Non-release `push` with product, test, workflow, or unknown delta                      | `full`       | `full`                      | `optimized`                         | yes            |
| Exact `release:prepare` output; PR CI passed                                           | `full`       | `skipped`                   | `control`                           | no             |
| Unknown or missing event                                                               | `full`       | `full`                      | `control`                           | yes            |

The pure retry, execution-plan, and green-reuse evaluators each have focused tests. The ordered
GitHub lookup and `main` orchestration glue remain fail-closed but do not have a direct IO-level
unit test; this is accepted while no concrete glue regression justifies extracting or mocking that
boundary. Adding a new decision dimension must update the pure policy tests and this matrix before
changing workflow wiring.

## Affected pull requests and the nightly full suite

A ready source PR no longer runs the full suite. `scripts/ci-execution-plan.ts` routes it to the
`affected` scope:

- **Checks**: changed-file lint and repository typecheck through `bun run check`, then
  `vitest related --run` over the changed sources. `related` walks the whole import graph, so a
  change in a shared package reaches every suite that transitively imports it.
- **E2E**: the union of specs declared in the PR body with one
  `CI-E2E-Tests: ["e2e/example.e2e.ts"]` line, ordinary specs the PR changed, and specs that directly
  import a changed source file, each run once. The policy job has no dependency install, so the E2E
  job adds the import-derived specs. With nothing selected, the PR runs `e2e/smoke.e2e.ts`.
  Protected specs (performance, real Agent, failure isolation) never run on this path.
- **Full-suite fallback**: a delta that touches a retry-protected path (workflows, CI runners,
  `e2e/support/**`, toolchain files) or any workspace `package.json`, `tsconfig*.json`,
  `vite`/`vitest`/`electron.vite`/`playwright` config, or `patches/**` keeps the full optimized
  suite, as does a malformed or protected `CI-E2E-Tests` declaration.

Knip, React Doctor, bundle budgets, the Renderer performance gate, and every unselected E2E spec now
run only in the `full` checks scope: the nightly full suite, or a ready PR that takes the
full-suite fallback above. The `affected` scope's `check --lint` never passes `--knip`, so an unused
export a PR introduces fails the next nightly unless the author ran `bun run knip` locally. The `schedule` trigger runs it on `main` at 00:00 UTC (08:00
Asia/Shanghai) in its own concurrency group, so a release push cannot cancel it. When `main` has
not moved since the previous completed nightly, the run skips every gate. A failed nightly runs
`scripts/ci-nightly-report.ts`, which opens or comments on the single open `Nightly 全量 CI 失败`
issue with the failed jobs and steps plus every PR merged since the previous green nightly. The
workflow token cannot edit the owner Project, so whoever picks the issue up adds it to the Project
through `file-issue`.

Ordinary pushes to `main` stay skipped at the workflow level; only `release: v…` commits run CI.

## Current single-runner execution contract

- A full ready-PR or `main` run installs once in the E2E checkout. Inside the concurrent validation
  window it also creates and installs an owned disposable checkout for the platform-check revision:
  GitHub's synthetic merge on a PR, or the exact push on `main`. Checkout preparation and the
  unchanged full platform gates overlap exact-head E2E. The platform gates keep their original
  fail-fast order, while E2E still attempts both pools and the manifest even if another validation
  surface fails.
- The disposable checkout verifies the synthetic merge's raw parents. When `main` advanced while the
  run was queued, the merge ref's base parent no longer equals the event-payload base; the checkout
  accepts that drift only after proving the payload base is an ancestor of the merge-ref base, then
  continues with the merge-ref base (also as `CAXRI_REACT_DOCTOR_BASE`) and prints one
  `CAXRI_CHECKS_BASE_DRIFT {json}` line. A merge ref whose head parent is not the run's PR head is
  stale and fails closed with all SHAs; rerunning the job reuses the same frozen payload, so the
  only remedy is to rebase and force-push.
- Exact-head E2E verifies native modules and builds once. It then runs `desktop-exclusive` with one
  worker, the dispatch-only CI parity cases, and `parallel-safe` with three namespaced workers on the
  same `m2-24`; a failed first pool does not suppress the second pool. That order is a scheduling decision, not a
  dependency: the platform-checks branch is the CPU-heavy half and finishes before E2E does, so the
  one-worker pool is the one that should share the runner with it and the multi-worker pool runs
  after the checks have released their cores. The `workflow_dispatch` worker input stays bounded
  to 2–4 for frozen same-head comparisons.

### Four parallel workers, measured and rejected

The obvious next step after the pool stopped competing with the checks branch was a fourth worker,
and the receipt says it does not pay. Two same-branch runs, identical except for the worker count:

| Workers                                                                     | Serial spec time | Wall   | Workers busy | Cost per test | `parallel-safe` failures |
| --------------------------------------------------------------------------- | ---------------- | ------ | ------------ | ------------- | ------------------------ |
| 3 ([35555168511](https://github.com/tjx666/caxri/actions/runs/35555168511)) | 1218.5s          | 416.4s | 2.93 / 3     | None          | 1                        |
| 4 ([35557167068](https://github.com/tjx666/caxri/actions/runs/35557167068)) | 1444.5s          | 371.2s | 3.89 / 4     | **+18.5%**    | 2                        |

Both counts keep their workers busy, so the fourth worker is not idling: **the same tests simply
take 18.5% longer to run**. That is the runner saturating, and it converts a theoretical 103s saving
into 45s.

Those are also the 18.5% that decide the load-sensitive cases. The four-worker run failed
`toasts.e2e.ts:65` again and added `error-toast-recovery.e2e.ts:8`, both of which pass two
deterministic local repetitions at one worker. A single flaky failure costs a full rerun of a
~17-minute job, so 45s of wall time does not buy it back. `parallel-safe` stays at three workers.

The general rule the measurement gives: read serial ÷ wall before changing a worker count. When it
is already near the worker count, the pool is scheduling well and more workers buy contention, not
time. Growth in the **serial** total between two runs is the signal that the runner is saturated:
wall time alone hides it.

- Every successful product-affecting E2E-running path finishes with the fixed Renderer performance
  scenario. A spec-only `e2e-repair` reuses the failed head's unchanged product tree and skips it.
  The benchmark step rebuilds a profiling React Renderer after the production-build
  suites, applies the per-surface budgets in
  [`docs/renderer-performance.md`](renderer-performance.md), and uploads its machine-readable receipt.
  `CI gate` requires the step output to be `success`; changing the gate, benchmark command, or
  performance spec is protected retry configuration and therefore requires a full validation path.
- Every spec runs in `parallel-safe` unless `desktopExclusiveSpecs` names it with a reason; tests
  that need the exclusive pool move into a dedicated spec, so each logical pool needs only one
  Playwright invocation. `e2e/support/pools.ts` owns the reasons and admission conditions, and
  `scripts/__tests__/e2e-pools.test.ts` pins the specs that stay desktop-exclusive regardless of how
  their launch options later read. Adding a spec to that guard list is the way to record an audit
  that rejected it; removing one requires its own evidence.
- The Playwright invocation itself writes each pool receipt. Receipts distinguish planned,
  started, finished, passed, skipped, and failed tests; their verified union supplies the manifest
  hash without a separate `playwright --list` collection. CI logs the verified union as
  `CAXRI_E2E_MANIFEST` JSON. A `passed` receipt alone is not a green pool: the reporter writes it
  in `onEnd`, so the runner also requires every child to exit zero and every dispatched spec to
  appear in the receipt, and records any breach as `abortedInvocations` or `missingSpecs` on the
  receipt with `status: failed`. `scripts/run-e2e-pools.ts` also survives the `SIGTERM` a failed
  sibling component (or the shared deadline below) sends it, long enough to write a partial receipt
  with `abortReason` instead of losing whatever already failed before the signal arrived. The
  reporter also appends each settled test to a `<receipt>.progress.jsonl` journal, so the
  invocation the signal killed before `onEnd` still contributes its finished verdicts and failure
  artifacts; only specs it never reached land in `missingSpecs`.
- Every required output is checked before every launch. Each Playwright worker performs one full
  recursive build-input scan, then reuses it until a filesystem event or mtime snapshot invalidates
  the cache; watcher failure falls back to scanning.
- The concurrent orchestrator writes one versioned receipt only after both validation branches
  finish. Independent checks, parallel-safe, desktop-exclusive, and auxiliary verifier steps bind
  that receipt to the Actions run attempt, platform-check revision, exact head, profile, and
  worker count; a missing, stale, malformed, or non-zero component fails closed.
- Focused checks, one-worker controls, retry-only runs, and non-full profiles keep their standalone
  paths. Only a full optimized run can replace the standalone checks job with the concurrent path.
- Vitest defaults to the audited `optimized` partition and two workers on both the standalone and
  the concurrent full path, so the checks branch finishes early and overlaps as little of
  `parallel-safe` as it can instead of spreading the same work into it. The `legacy` partition and worker caps 1-4 remain
  workflow-dispatch controls for same-head measurement; real watcher, process-global, bridge, and
  Git suites stay in `serial-native`.

## Performance regression baseline

The fixed thresholds `renderer-performance` asserts catch a large, sudden regression but never a
steady creep: a change that costs 3% every time never crosses a fixed number. `Run Renderer
performance baseline gate` runs immediately after that step and additively compares the same
receipt against a noise-derived, committed baseline, `scripts/performance-baseline.json`. A separate
scheduled workflow, [Gradual-creep trend check](#gradual-creep-trend-check), watches for the creep the
per-run gate cannot see by itself. All three checks are independent: a failure in one never
suppresses another.

The design below replaced a flat `median + 5·MAD` threshold ([issue tjx666/caxri#1439][issue-1439])
after backtesting it against 98 real `renderer-performance-receipt` artifacts from self-hosted CI
runs: that design false-failed 13 of the 98 runs on `durationMs`, 3 on `react.actualDurationP95Ms`,
and 3 on `interactions.maxDurationMs`, because `k·MAD` collapses when a metric's bulk of samples
cluster within a fraction of their own unit of the median (frame- or event-loop-quantized metrics)
or the distribution is multimodal. It also could not detect the issue's motivating case at all: a
steady ~3% (~6ms) creep sits entirely within the natural 192-229ms run-to-run spread of a single
sample, which is why gradual-creep detection is now a separate rolling-window check rather than
something the per-run gate is asked to do.

[issue-1439]: https://github.com/tjx666/caxri/issues/1439

### Per-run gate: design and backtest

`scripts/performance-baseline.ts`'s `derivePerformanceMetricBaseline` classifies each metric as
**continuous** or **discrete** by the _shape_ of its samples (`isDiscretePerformanceMetric`: every
sample in the derivation window is a whole number), not by name: a dot-path allowlist of "count"
names would miss `interactions.maxDurationMs`, a genuine duration the Event Timing API quantizes to
one of only four values (16/24/32/40ms):

- **Continuous** (ordinary sub-millisecond-resolution durations, e.g. `durationMs`,
  `react.actualDurationP95Ms`): `thresholdMs = max(median + k·MAD, historicalMax) * (1 +
relativeMargin) + absoluteMarginMs`. `k·MAD` (`k = 5`, `DEFAULT_PERFORMANCE_THRESHOLD_K`) is a real
  spread estimate but collapses on this distribution, so the threshold anchors to the observed
  historical maximum instead, with a margin absorbing the chance that the next clean run's maximum
  lands slightly past every one already seen. `relativeMargin = 0.08` (`DEFAULT_PERFORMANCE_RELATIVE_MARGIN`)
  plus `absoluteMarginMs = 1` (`DEFAULT_PERFORMANCE_ABSOLUTE_MARGIN_MS`, a floor so a percentage margin
  stays meaningful on a near-zero metric) was the smallest combination that reached a 0%
  false-failure rate on both backtests below.
- **Discrete** (render/commit counts, and frame-quantized durations like
  `interactions.maxDurationMs`): `thresholdMs` is the bare historical maximum, margin `0`. An intended
  increase (a new count that is genuinely supposed to be higher) requires an explicit baseline
  refresh rather than silently widening on its own next time it is sampled.
- **Excluded** (`isExcludedPerformanceMetric`, an exact-name list, not a pattern): these metrics are
  never compared or trend-checked.
  - `react.baseDurationMaxMs` and `react.surfaces.primary-sidebar.baseDurationMaxMs`, not every
    `baseDurationMaxMs` variant. This metric estimates the render cost React _would have_ paid without
    memoization; on exactly these two paths, the 98-receipt corpus contains two outliers (11.2ms and
    15.5ms against a 3.4-6.8ms bulk) that no plausible margin absorbs without also hiding a real
    regression of similar size (1/98 leave-one-out and 2/49 time-split false failures even with the
    margin applied). The same backtest run against `react.surfaces.workbench.baseDurationMaxMs` and
    `react.surfaces.secondary-sidebar.baseDurationMaxMs` (whose historical maxima are 3.3ms and 2.9ms,
    with no comparable outlier) found 0 false failures on both checks without any exclusion, so those
    two stay gated instead of being swept into the same exception.
  - `frames.sampleCount`, for a structural reason: it counts requestAnimationFrame intervals inside the
    exact window `durationMs` times, so it is `durationMs` rounded down to whole vsyncs, with no
    information of its own. As a discrete metric it thresholds at the bare historical maximum (13
    intervals), which rejects windows from about 233.3ms while `durationMs`'s own backtested threshold
    accepts up to 248.104ms, so it silently re-gated `durationMs` more strictly than its backtest
    supports. See the [`frames.sampleCount` backtest](#framessamplecount-backtest) below. The frame
    metrics that carry their own signal (`frames.missedFrameCount` and the interval percentiles) stay
    gated.
  - The `session.select` and `app.bootstrap` round-trip durations (`requests.*.maxDurationMs` and
    `requests.*.totalDurationMs`), because they are cross-process wall-clock times on the shared
    runner, the same reason frame and Event Timing metrics stay diagnostic. They are bimodal (about
    6ms or about 33ms, nothing between) and the same head flips between the modes on a rerun. Each
    request's `count` stays gated, and `e2e/renderer.performance.e2e.ts` keeps its fixed 100ms
    ceiling per request. See the [request round-trip backtest](#request-round-trip-backtest) below.

  An excluded metric's raw evidence (`historicalMaxMs`, `sampleCount`) is written into the committed
  baseline's own `excluded` map, not only logged by the derive command, so a later reader of
  `scripts/performance-baseline.json` can audit the exclusion without re-running the derivation. Add
  another name only with the same kind of per-metric backtest evidence: this is a documented, narrow
  exception, not a place to route every noisy metric or every variant of a noisy metric's family.

A metric needs at least `MINIMUM_PERFORMANCE_SAMPLE_COUNT` (8) samples before any threshold is
derived; fewer make even the historical maximum untrustworthy, so the metric is skipped rather than
gated on noise. `RECOMMENDED_MINIMUM_RUNNER_SAMPLE_COUNT` (40) is the point the backtest below
actually reached 0% false failures at; `--source runner` derivation below that count still arms, but
warns, because a first-time arming has no larger corpus to draw from.

**Backtest**, run against the 98-receipt `durationMs` corpus (the same numbers are embedded and
re-verified in `scripts/__tests__/performance-baseline.test.ts`'s
`durationMs historical backtest (real runner receipts)` suite):

| Method                                                                                            | Result                                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Flat `median + 5·MAD` (previous design)                                                           | 13/98 false failures                                                         |
| Leave-one-out (hold out each of the 98 receipts, derive from the other 97, gate the held-out one) | 0/98 false failures                                                          |
| Forward time-split (derive from the older 49 receipts, gate the newer 49)                         | 0/49 false failures                                                          |
| Smallest injected fixed delay that reliably fails every one of the 98 receipts                    | **+57ms** (~27% over the ~211ms median)                                      |
| Largest injected fixed delay that does _not_ reliably fail every receipt                          | +56ms (fails 97/98: one receipt's own historical maximum already absorbs it) |

+57ms is the gate's practical sensitivity floor for `durationMs` today: a sudden regression smaller
than that on a metric with this much natural spread can pass a single run, which is exactly why the
trend check below exists for the smaller, sustained case.

#### `frames.sampleCount` backtest

Run against the same 98 receipts and, as forward evidence, the 48 runner receipts the armed gate
compared afterwards (2026-09-28 to 2026-10-10). The corpus numbers are embedded and re-verified in
the `frames.sampleCount historical backtest (real runner receipts)` suite of
`scripts/__tests__/performance-baseline.test.ts`; its `committed baseline replay` suite replays the
245.4ms, 14-interval run from [issue tjx666/caxri#1637][issue-1637] against the committed baseline.

| Check                                                              | Result                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `frames.sampleCount` equals `floor(durationMs / 16.67ms)`          | 97/98 receipts; the remaining one is one interval less                             |
| Leave-one-out and forward time-split on `frames.sampleCount` alone | 0/98 and 0/49 false failures                                                       |
| Shortest window the bare-maximum threshold (13 intervals) rejects  | ~233.3ms, inside `durationMs`'s 248.104ms threshold                                |
| Post-arming receipts replayed against the committed baseline       | 13/48 failed; 3 of them on `frames.sampleCount` alone                              |
| Post-arming receipts with 14 intervals                             | 6/48, all with `durationMs` between 242.7ms and 247.5ms (within its own threshold) |
| Same 48 receipts after the exclusion                               | 10/48 failed, none on `frames.sampleCount`; `durationMs` itself failed 0/48        |

The per-metric backtest alone found nothing because the 98-receipt corpus never reached 14 intervals;
the failure is the frame count's bare maximum sitting inside `durationMs`'s margin, which only later
runs near that margin exposed. One of the three runs it failed passed on a rerun of the same head.

[issue-1637]: https://github.com/tjx666/caxri/issues/1637

#### Request round-trip backtest

Run against the same 98 receipts and the same 48 post-arming receipts, ordered by job, with the
repository's own `derivePerformanceMetricBaseline`. `maxDurationMs` and `totalDurationMs` are equal
in every receipt because the scenario sends each request once
([issue tjx666/caxri#1638][issue-1638]).

| Check                                                        | `session.select`                    | `app.bootstrap`                 |
| ------------------------------------------------------------ | ----------------------------------- | ------------------------------- |
| 98-receipt corpus: leave-one-out and forward time-split      | 0/98 and 0/49                       | 0/98 and 0/49                   |
| Post-arming receipts replayed against the committed baseline | 9/48 failed (30.3-37ms; one 11.5ms) | 1/48 failed (36.5ms)            |
| All 146 receipts: forward time-split                         | 9/73                                | 1/73                            |
| Threshold a re-derivation over all 146 would need            | 40.96ms (6.8x the 6ms median)       | 40.42ms (5.9x the 6.9ms median) |
| Same 48 receipts after the exclusion                         | 0/48 failed on any metric           | 0/48 failed on any metric       |

The arming corpus held no slow-mode receipt, so the per-metric backtest could not see the mode; the
first 114 receipts had none and the next 32 had 10. The slow mode is not a Renderer stall: the
failing receipts' frame intervals stayed under 18.6ms with no missed frame or Long Animation Frame,
and `app.bootstrap`, which starts when `session.select`'s `state.changed` event arrives, stayed at
6.2-7.1ms in the same runs, so the extra time precedes Server Core's broadcast. A re-derived ~41ms
threshold would sit 4ms over the observed 37ms maximum and close to the spec's 100ms ceiling, so it
would gate nothing that ceiling does not.

[issue-1638]: https://github.com/tjx666/caxri/issues/1638

### Armed vs. unarmed: why this never silently passes

`scripts/performance-baseline.json` carries an explicit `armed` boolean. Only `armed: true` lets the
gate fail a build; an unarmed baseline still runs the comparison and prints a full before/after table
(state `unarmed`), but never fails CI on it. `scripts/performance-baseline-derive.ts` hardcodes
`armed: options.source === 'runner'`, so a baseline derived from `--source local` samples can never
be armed by construction: a contributor's own Mac, shared with sibling agent sessions and under
different thermal and load conditions than the self-hosted CI runner, is evidence for the
statistical method, never a stand-in for the runner's own noise. A missing or metric-less baseline
reports `no-baseline`; a run whose changed files are not performance-relevant (see
`isPerformanceRelevantPath` in `scripts/ci-path-policy.ts`) reports `skipped`. An armed baseline
whose metric names have zero overlap with the current run (every one of them renamed or restructured
away, for example a benchmark spec reshaping its JSON payload) reports `drifted` rather than
`passed`: `rows` is empty, so a naive "any row regressed" check is vacuously false, and `drifted` exists
precisely so that vacuous truth is never mistaken for a clean run. `drifted` does not fail the build
(re-deriving the baseline is an operator action, not a regression), but it also never renders as
`PASSED` in the job log or step summary, and the table always names the vanished metrics. None of
`unarmed`, `no-baseline`, `skipped`, or `drifted` ever reports as a `passed` comparison: the job log
and step summary always show which of these states produced the outcome.

### Refreshing the baseline

Refreshing is always this explicit, reviewable command: nothing writes
`scripts/performance-baseline.json` implicitly:

```bash
bun run performance:baseline:collect -- --spec e2e/renderer.performance.e2e.ts --iterations 10 \
  --env CAXRI_RENDERER_BENCHMARK=1 --env CAXRI_E2E_OUTPUT_DIR=test-results/renderer-performance \
  --out test-results/receipts/performance-baseline-samples.json
bun run performance:baseline:derive -- --source local --spec e2e/renderer.performance.e2e.ts \
  --input test-results/receipts/performance-baseline-samples.json --out scripts/performance-baseline.json
```

The Renderer scenario needs a profiling build first
(`CAXRI_REACT_PROFILING=1 bun run build`); a stale bundle measures the wrong code. A `--source
local` derive always writes `armed: false`, so this recipe is a way to validate the statistical
method and preview the resulting thresholds, never a way to arm the runner gate.

### Arming the gate from CI samples, without runner SSH

The self-hosted runner is a single shared machine; no session or contributor runs commands on it
directly to collect samples. Instead, every `e2e` job that reaches `renderer-performance` already
uploads its receipt as the `renderer-performance-receipt` artifact. Once enough green `main` runs
have accumulated (`RECOMMENDED_MINIMUM_RUNNER_SAMPLE_COUNT`, 40, or more for a stable historical
maximum), a maintainer arms the baseline by downloading those artifacts and deriving from them with
`--source runner`:

```bash
mkdir -p /tmp/performance-runs
for run_id in <run-id-1> <run-id-2> <run-id-3> …; do
  gh run download "$run_id" --name renderer-performance-receipt \
    --dir "/tmp/performance-runs/$run_id"
done

bun run performance:baseline:derive -- --source runner --spec e2e/renderer.performance.e2e.ts \
  --input-dir /tmp/performance-runs --out scripts/performance-baseline.json \
  --provenance "<n> renderer-performance-receipt artifacts from self-hosted CI runs <first-run-id>-<last-run-id> (<start-ISO-date> to <end-ISO-date>)"
```

`--input-dir` recursively finds every `renderer-performance.json` under the given directory
(matching the layout `gh run download` produces, one receipt per downloaded run) so a maintainer
never has to loop over `--input` by hand. `--source runner` requires `--provenance`: a short
free-text description of which artifacts this came from (an artifact/run id range and a date range:
never a local filesystem path, since the receipts live in an operator-chosen temp directory that
must not end up in a committed, eventually-public file). The committed `scripts/performance-baseline.json`
was armed this way from 98 receipts; its `provenance` field reads:

```text
98 renderer-performance-receipt artifacts from self-hosted CI runs 35967460812-36421490139 (2026-09-24T07:13:31Z to 2026-09-28T12:48:30Z)
```

Commit the resulting `scripts/performance-baseline.json`. Its `armed: true` and `source: "runner"`
are then load-bearing: the next CI run compares against a real runner-noise threshold and can fail
the job. Re-run the same recipe against a fresh window of runs to refresh the baseline as the
product's genuine performance profile shifts: never hand-edit the JSON file.

The receipt artifacts expire after seven days, but the `e2e` job log keeps the same receipt as its
`CAXRI_RENDERER_BENCHMARK {...}` line (`e2e/renderer.performance.e2e.ts` prints the exact payload it
writes). To re-derive from an expired window, for example after adding an exclusion, fetch each
run's `e2e` job log with `gh api repos/{owner}/{repo}/actions/jobs/<job-id>/logs`, write its last
`CAXRI_RENDERER_BENCHMARK` payload to `<dir>/<job-id>/renderer-performance.json`, and run the same
`--input-dir` derivation. Before committing, confirm the result reproduces every unchanged metric of
the committed baseline exactly, which proves the reconstructed set is the original one. The
`frames.sampleCount` exclusion was applied this way: the reconstructed 98 receipts reproduced all 60
previously gated metrics, so the regenerated file differs only by that metric's move to `excluded`,
`recordedAt`, and `commit`.

### Gradual-creep trend check

The per-run gate's margin (see the backtest above: +57ms, ~27%, to reliably fail `durationMs`) is
deliberately too wide to catch a steady 3-5% creep (the issue's motivating case) because that creep
sits inside a single run's ordinary noise. `scripts/performance-trend.ts`'s `evaluatePerformanceTrend`
instead compares the **median of the most recent `windowSize` runner receipts** against the committed
baseline's median, so a persistent shift accumulates evidence across many runs instead of needing to
clear a margin on any one of them.

`DEFAULT_TREND_WINDOW_SIZE` (`N = 20`) and `DEFAULT_TREND_ALARM_RATIO` (`X = 2%`) were chosen by
bootstrap-resampling the same 98-receipt `durationMs` corpus (20,000 trials, simulating a 90-run
horizon of ordinary noise at each candidate `N`/`X`):

| Property                                                        | Result                  |
| --------------------------------------------------------------- | ----------------------- |
| False-alarm rate over a 90-run noise-only horizon at N=20, X=2% | ~0.05% (20,000 trials)  |
| Detection latency for a sustained 3% creep                      | median 11 runs (p95 14) |
| Detection latency for a sustained 5% creep                      | median 10 runs (p95 12) |

`TREND_ELIGIBLE_METRICS` scopes the check to `durationMs` only, on the same bootstrap evidence: at
this `N`/`X` every other continuous metric in the corpus (the per-request IPC timings, the React
`actualDuration*` family) false-alarms 40-90% of the time, because their sub-millisecond scale
amplifies rounding noise into double-digit percentages. `durationMs` (the scenario's overall
wall-clock time, and the metric the issue's "steady 3% creep" example names) is the one metric this
bootstrap found suitable; extend the list only with the same kind of evidence recorded here.

`evaluatePerformanceTrend` mirrors the per-run gate's never-silently-passed discipline with its own
explicit states: `no-baseline` / `unarmed` (a trend check against a baseline that cannot fail the
per-run gate must not fail this one either), `no-eligible-metrics` (none of `TREND_ELIGIBLE_METRICS`
has a continuous armed baseline entry), `insufficient-receipts` (fewer than `windowSize` recent
receipts were found), and `alarm` / `ok`.

`.github/workflows/performance-trend.yml` runs this check on a GitHub-hosted `ubuntu-latest` runner,
deliberately not `ci.yml`'s self-hosted `caxri-ci` runner, since it needs no Electron launch and no
build. It triggers on a daily `schedule` (18:00 UTC) and `workflow_dispatch` (with `window` and
`alarm_ratio` overrides) only (never `pull_request`), so it costs no self-hosted runner time and
stays out of the required PR guards. With `permissions: actions: read`, it lists the most recent
`renderer-performance-receipt` artifacts via `gh api .../actions/artifacts`, downloads each with
`gh run download`, and runs `bun run performance:trend:check -- --baseline
scripts/performance-baseline.json --receipts-dir <dir> --window <N> --alarm-ratio <X>`, which writes
its table to the job's step summary and exits non-zero on `alarm`.

### Scope: which changes pay for the comparison

`Run Renderer performance baseline gate` only compares when `CI_CHANGED_FILES` (the same
`needs.retry-policy.outputs.changed_files` the `checks` job already reads) intersects
`isPerformanceRelevantPath`: Desktop main/preload/renderer source, Server source, the shared
Client/protocol/system packages, a performance E2E spec, or the baseline's own script/JSON files.
An unrelated change (docs, an extension, a CLI-only fix) never pays for a comparison that cannot
regress what the baseline measures. Outside CI, or when there is no changed-files signal to reason
about at all, the gate always compares: an operator running it by hand wants a real answer, not a
skip. The trend check has no such scoping: it never runs on a pull request in the first place, so
every scheduled or manually dispatched run always compares.

### Cost

The gate step itself reads two small JSON files and does no build or Electron launch; its own cost
is sub-second. It is gated on `renderer-performance` having produced a receipt at all (`if: always()
&& steps.renderer-performance.outcome != 'skipped'`), so it adds no new build, no new Electron
launch, and no new CI minutes beyond that near-instant read-and-compare. The trend check's own
GitHub-hosted job cost is likewise near-instant (an artifact list, a handful of small downloads, and
one JSON comparison) and never touches the self-hosted runner's queue.

## Comparison contract

Freeze exact head, manifest, Node/pnpm versions, lockfile hash, runner label, workflow inputs, cache
state, and counts before comparing profiles. Report median end-to-end wall time, dominant steps,
peak process-tree RSS, cache state, and every non-green attempt. Adopt a parallelism or concurrency
change only when correctness and isolation stay green and self-hosted medians improve; otherwise
restore control and record the rejection. `CAXRI_VALIDATION_ENV`, `CAXRI_CACHE_STATE`,
`CAXRI_CI_METRIC`, `CAXRI_E2E_MANIFEST`, and `CAXRI_RENDERER_BENCHMARK` provide the machine-readable
inputs for that report;
the owning issue or PR records the candidate-specific samples and adoption decision.

Before dispatch, freeze the sample count, dispatch order, expected minimum wall time from the most
recent same-runner result, and stop condition. A median comparison normally means three control and
three candidate samples; queue that frozen set once, record run ids immediately, and do not replace
red samples unless a documented unrelated infrastructure failure invalidated them. Tell the user
that lower bound before the runner is occupied. Stop after the declared set and generate one report
from the recorded metrics rather than extending the experiment with manually assembled evidence.

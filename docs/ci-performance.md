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
| 3       |     3:20 | skipped |              — |      — | failed |              — |          — | late copy-timeout rejection                 |
| 4       |     3:12 | skipped |              — |      — | failed |              — |          — | same rejection plus hosted worktree timeout |
| 5       |     3:40 | skipped |              — |      — | failed |              — |          — | late copy-timeout rejection                 |

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
and a stalled Renderer there does not merely run slower — an interaction that races an asynchronous
re-render starts losing it, which is a flaky test rather than a slow one.

[Run 35553657625](https://github.com/tjx666/caxri/actions/runs/35553657625) is the first run where
that window got large. `desktop-exclusive` ended at 02:26:49 and the checks branch ran until
02:32:47, so 358s of the 452s three-worker pool — 79% of it — ran under full contention. Three
specs failed that no change in that run had touched: `git-diff-tabs` (Monaco diff never mounted
after the click), `terminal-commands` (a split remount that never reset its command tracker), and
`toasts` (a toast dismiss button that never appeared). All three pass two deterministic local
repetitions at one worker. They are tracked as load-sensitive cases in
[issue #877](https://github.com/tjx666/caxri/issues/877).

This is a plausible cause rather than a proven one: the same run also added `agent-delegation` to
the pool, which raises in-pool CPU load by itself, and an earlier green run overlapped its
three-worker pool with the checks branch completely. What both explanations share is CPU saturation
during `parallel-safe`, so that is what the concurrent path reduces: Vitest runs with two workers
there, matching the standalone checks job. Total CPU work is unchanged — a one-worker Vitest spreads
the same work across a longer window, and the window is what reaches into the fragile pool. The
extra worker lands during `desktop-exclusive`, which has the headroom for it.

Treat this as a standing constraint whenever a pool gets faster: **the checks branch should finish
before `parallel-safe` starts.** Shorten the checks branch to restore it; never slow E2E back down.

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
and blames the wrong spec — it attributed 125s to `logs-panel.e2e.ts` when the cost belonged to
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

After that repair the exclusive pool has no outlier left — it is a flat tail of 3–30s specs — so the
remaining lever is moving work out of it rather than making individual tests faster.

### Auditing the exclusive pool for admission

Screening the same run's 65 exclusive specs against the `parallelSafeSpecs` conditions left 26 with
no mechanical disqualifier; reading those individually admitted 17, worth about 146s of one-worker
time, and moved the split from 71/65 to 88/48. The rejections are the useful part of the record:

- `logs-panel.e2e.ts` asserts its own query cadence in real milliseconds, which is a wall-clock
  assertion however fast the machine is.
- `menu-keybinding-recovery.e2e.ts` reads the installed native application menu.
- `agent-delegation.e2e.ts` — the single largest spec at 95s — drives the CLI through a `spawnSync`
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
actually disqualified — worth remembering the next time a screen is mistaken for a verdict.

That re-screen also surfaced a real defect. `clipboardCapabilitySpecs` is the list that keeps a
clipboard-requesting spec out of the parallel pool, and it had fallen three entries behind the specs
themselves (`editor-git-actions`, `file-preview`, `project-path-actions` all pass `clipboard: true`
while unlisted). A stale entry there fails nothing on its own; it just silently stops protecting the
spec it forgot. `scripts/__tests__/e2e-pools.test.ts` now derives the set from the spec sources and
fails when the list disagrees.

`agent-delegation.e2e.ts` was readmitted on the same principle. The condition excludes a subprocess
timeout with little headroom, and its synthetic CLI allowed `spawnSync` only 5 seconds beyond the
20-second wait it was invoking. That missing margin was a defect in the spec, not a property of what
it tests, so the fix is to give the subprocess enough (45s) rather than to keep the largest spec in
the pool on one worker forever. Under three workers it passes alongside `work-tab-sizing` and
`terminal-recovery`: 24 tests in 1.3m.

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
  two-worker pool so local validation matches CI scheduling pressure.
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

- **Checks** — changed-file lint and repository typecheck through `bun run check`, then
  `vitest related --run` over the changed sources. `related` walks the whole import graph, so a
  change in a shared package reaches every suite that transitively imports it.
- **E2E** — the union of specs declared in the PR body with one
  `CI-E2E-Tests: ["e2e/example.e2e.ts"]` line, ordinary specs the PR changed, and specs that directly
  import a changed source file, each run once. The policy job has no dependency install, so the E2E
  job adds the import-derived specs. With nothing selected, the PR runs `e2e/smoke.e2e.ts`.
  Protected specs (performance, real Agent, failure isolation) never run on this path.
- **Full-suite fallback** — a delta that touches a retry-protected path (workflows, CI runners,
  `e2e/support/**`, toolchain files) or any workspace `package.json`, `tsconfig*.json`,
  `vite`/`vitest`/`electron.vite`/`playwright` config, or `patches/**` keeps the full optimized
  suite, as does a malformed or protected `CI-E2E-Tests` declaration.

Knip, React Doctor, bundle budgets, the Renderer performance gate, and every unselected E2E spec now
run only in the nightly full suite. The `schedule` trigger runs it on `main` at 00:00 UTC (08:00
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
  worker followed by `parallel-safe` with three namespaced workers on the same `m2-24`; a failed
  first pool does not suppress the second pool. That order is a scheduling decision, not a
  dependency: the platform-checks branch is the CPU-heavy half and finishes before E2E does, so the
  one-worker pool is the one that should share the runner with it and the multi-worker pool runs
  after the checks have released their cores. The `workflow_dispatch` worker input stays bounded
  to 2–4 for frozen same-head comparisons.

### Four parallel workers, measured and rejected

The obvious next step after the pool stopped competing with the checks branch was a fourth worker,
and the receipt says it does not pay. Two same-branch runs, identical except for the worker count:

| Workers                                                                     | Serial spec time | Wall   | Workers busy | Cost per test | `parallel-safe` failures |
| --------------------------------------------------------------------------- | ---------------- | ------ | ------------ | ------------- | ------------------------ |
| 3 ([35555168511](https://github.com/tjx666/caxri/actions/runs/35555168511)) | 1218.5s          | 416.4s | 2.93 / 3     | —             | 1                        |
| 4 ([35557167068](https://github.com/tjx666/caxri/actions/runs/35557167068)) | 1444.5s          | 371.2s | 3.89 / 4     | **+18.5%**    | 2                        |

Both counts keep their workers busy, so the fourth worker is not idling — **the same tests simply
take 18.5% longer to run**. That is the runner saturating, and it converts a theoretical 103s saving
into 45s.

Those are also the 18.5% that decide the load-sensitive cases. The four-worker run failed
`toasts.e2e.ts:65` again and added `error-toast-recovery.e2e.ts:8`, both of which pass two
deterministic local repetitions at one worker. A single flaky failure costs a full rerun of a
~17-minute job, so 45s of wall time does not buy it back. `parallel-safe` stays at three workers.

The general rule the measurement gives: read serial ÷ wall before changing a worker count. When it
is already near the worker count, the pool is scheduling well and more workers buy contention, not
time. Growth in the **serial** total between two runs is the signal that the runner is saturated —
wall time alone hides it.

- Every successful product-affecting E2E-running path finishes with the fixed Renderer performance
  scenario. A spec-only `e2e-repair` reuses the failed head's unchanged product tree and skips it.
  The benchmark step rebuilds a profiling React Renderer after the production-build
  suites, applies the per-surface budgets in
  [`docs/renderer-performance.md`](renderer-performance.md), and uploads its machine-readable receipt.
  `CI gate` requires the step output to be `success`; changing the gate, benchmark command, or
  performance spec is protected retry configuration and therefore requires a full validation path.
- Individually audited tests may move into a dedicated spec in the `parallelSafeSpecs` allowlist.
  Every unclassified spec remains desktop-exclusive, so each logical pool needs only one
  Playwright invocation. `e2e/support/pools.ts` owns the admission conditions, and
  `scripts/__tests__/e2e-pools.test.ts` pins the specs that stay desktop-exclusive regardless of how
  their launch options later read. Adding a spec to that guard list is the way to record an audit
  that rejected it; removing one requires its own evidence.
- The Playwright invocation itself writes each pool receipt. Receipts distinguish planned,
  started, finished, passed, skipped, and failed tests; their verified union supplies the manifest
  hash without a separate `playwright --list` collection. CI logs the verified union as
  `CAXRI_E2E_MANIFEST` JSON. A `passed` receipt alone is not a green pool: the reporter writes it
  in `onEnd`, so the runner also requires every child to exit zero and every dispatched spec to
  appear in the receipt, and records any breach as `abortedInvocations` or `missingSpecs` on the
  receipt with `status: failed`.
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
  the concurrent full path, so the checks branch clears the runner before `parallel-safe` starts
  rather than spreading the same work into it. The `legacy` partition and worker caps 1-4 remain
  workflow-dispatch controls for same-head measurement; real watcher, process-global, bridge, and
  Git suites stay in `serial-native`.

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

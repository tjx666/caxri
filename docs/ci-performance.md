---
kind: living
status: current
---

# CI and E2E Performance Evidence

This is the single source of truth for CI optimization decisions, execution profiles, and
performance evidence. It preserves historical GitHub-hosted and self-hosted samples, non-green
attempts, correctness constraints, and resource controls while defining the current GitHub-hosted
routes. A failed path is useful failure-cost data, but it is never a green performance baseline.

## Baseline

Actions run `31581073589` used exact head
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
CI; record a new exact-head GitHub-hosted baseline before making further install-time claims.

### Single-runner concurrent-window baseline

Actions run `34601568589` was a full optimized ready-PR run on the historical self-hosted runner.
Its `e2e` job took 15m43s end to end, and the concurrent validation window
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

Actions run `35553657625` was the first run where
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

Actions run `35542871828` measured a 22m20s `e2e`
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

`scheduleConcurrentValidationDeadline` in `scripts/ci-concurrent-validation.ts` aborts a runner's
window 25 minutes after `execute()` starts. The deadline is per runner: the optimized `hosted-full`
route now splits the work across three jobs, each with its own window and its own 30-minute job
timeout (issue #1869), selected by `CAXRI_E2E_COMPONENT`:

| Job                  | Component       | Work                                                                                                                                       |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `e2e`                | `exclusive`     | Electron build, native verification, `desktop-exclusive` shard `1/2`, its manifest                                                         |
| `e2e-parallel`       | `parallel-safe` | Build and native verification, then one shard `i/3` of `parallel-safe` (matrix `1/3`, `2/3`, `3/3`, `fail-fast: false`), its manifest      |
| `e2e-parallel`       | `exclusive`     | The matrix `include` entry `{component: exclusive, shard: 2/2}`: build, native verification, `desktop-exclusive` shard `2/2`, its manifest |
| `e2e-perf`           | none            | Build, native verification, interruption recovery, failure-census fixture, dispatch-only CI parity, the performance gates                  |
| `checks-hosted-full` | none            | The full platform checks on `ubuntu-latest`, outside every E2E window                                                                      |

Run `41226124386` measured the single-runner window: Electron Vite build 157s, interruption
recovery 32s, `desktop-exclusive` 882s (two failures), CI parity 181s, and `parallel-safe` (392
tests) at about 0.27 tests/s with three workers. Together with the checks branch that overran the
window and aborted it, so the performance gates never ran. Splitting gives each leg its own clock:
the exclusive leg is about 20 minutes (build and the 882s pool), each shard owns
about half of the 392 tests, and the performance leg no longer depends on whether the window
aborted.

Run `41230137464` (the first split run) still overran the 21m15s target on every pooled leg, for two
reasons that the second iteration removes (issue #1869):

- **The 3-failure cap turned a red pool into a serial rerun.** Playwright's `maxFailures` is 3 under
  `CI`. After the third failure every test not yet run is `unknown`, and the per-pool failure census
  (`censusTargets` in `scripts/run-e2e-pools.ts`) reran each such spec alone at `workers=1`, throwing
  away the pool's parallelism: shard 1 planned 184 tests, stopped after about 207 s with 63 attempted
  (about 0.30 tests/s), then spent about 14 minutes on roughly 116 one-spec reruns (about 0.14
  tests/s). Shard 2 and the exclusive leg hit the 25-minute deadline inside the same rerun loop. The
  `e2e` and `e2e-parallel` legs now set `CAXRI_E2E_MAX_FAILURES=0` (the `e2e` leg only on the optimized
  full-scope route), which `playwright.config.ts` reads through
  `scripts/reporters/e2e-max-failures-policy.ts`: one invocation runs every test at full parallelism
  and records every failure, so no test is `unknown` and the census loop has nothing to rerun. The
  census code and `scripts/run-e2e-census-fixture.ts` stay for aborts and crashes; the fixture and
  the isolation proof pass their own `--max-failures`. Other routes keep the CI cap of 3. A mass
  failure is still bounded by the 25-minute deadline and the 30-minute job timeout.
- **The checks branch inflated the exclusive build.** oxlint type-aware (about 330 s and 3.2 GB RSS)
  ran beside the exclusive leg's Electron Vite build, which took 384 s against 62 to 152 s on the
  other legs. The remaining full-scope gates are platform-neutral, so they now run as
  `checks-hosted-full` on `ubuntu-latest` with the same command as `checks`. `e2e` does not wait for
  it, and the `ci` gate requires it on this route and its skip everywhere else. Hosted-full is
  `workflow_dispatch` only, so the dispatched SHA the Linux job checks out is the tree the old
  synthetic-merge worktree held.

Interruption recovery (33 s) and the failure-census fixture (17 s) prove the harness rather than the
product, so they run as plain steps in `e2e-perf`, which has about 9 minutes of spare room, and no
longer count against the exclusive window.

Estimated windows after the second iteration (superseded by the third iteration below; run `41230137464` is the baseline): shard 2
with 208 tests at about 0.27 tests/s is about 770 s plus roughly 110 s of build and manifest, or 14.7
minutes; shard 1 is about 13.2 minutes. The exclusive leg is about 100 s of build and manifest plus
102 tests at 8.6 to 10.7 s each, or 16.5 to 21.3 minutes against the 21.25 minute budget. If the
first rerun lands above about 19.5 minutes, shard `desktop-exclusive` across two macOS runners
(allow `--shard` for that pool and add a second exclusive runner); a third `parallel-safe` shard is a
one-line matrix change if a shard measures above 18 minutes. Failures that reproduce at one worker
are real test failures to triage separately, not window problems.

### Third iteration: three parallel-safe shards, two exclusive shards

Run `41234104765` (the second iteration) hit no deadline, but three legs still sat at or over the 21m15s
target. Each window below is the measured build and manifest time plus the measured pool time:

| Leg                | Build and setup | Pool   | Tests | Window                 |
| ------------------ | --------------- | ------ | ----: | ---------------------- |
| `e2e` (exclusive)  | 118 s           | 1127 s |   102 | 20.8 min               |
| `e2e-parallel` 1/2 | 131 s           | 1171 s |   184 | 21.7 min (over target) |
| `e2e-parallel` 2/2 | 96 s            | 1047 s |   208 | 19.0 min               |

`e2e-perf` was comfortably inside its job, and `checks-hosted-full` took 2.5 minutes on Linux. The exclusive
leg's 1127 s includes four real failures that spend their timeouts; those failures are tracked separately and
were not fixed here, so every figure above is inflated by them.

The layout now is:

- `parallel-safe` runs as three shards (`1/3`, `2/3`, `3/3`).
- `desktop-exclusive` runs as two shards. "Exclusive" means one Electron at a time per machine, so two
  runners may each run half. `e2e` runs shard `1/2` (`CAXRI_E2E_SHARD=1/2` on the `concurrent-full` step
  only, so the direct control, focused, and `e2e-only` pool steps keep running the whole pool). Shard `2/2`
  is an `include` entry of the `e2e-parallel` matrix carrying `component: exclusive`; its shard value
  matches none of the `parallel-safe` shards, so GitHub adds it as an extra leg instead of extending one.
  The gate's job set stays `e2e`, `e2e-parallel`, `e2e-perf`, and `checks-hosted-full`.
- Each `e2e-parallel` leg derives its pool from the matrix: `CAXRI_E2E_COMPONENT` is `matrix.component`
  or `parallel-safe`, and `CAXRI_E2E_SHARD_POOL` (`desktop-exclusive` or `parallel-safe`) selects the
  `verify` argument, the receipt that gates the failure upload, and the artifact. Failure artifacts are
  `e2e-<pool>-failure-artifacts-shard-<job-index>`, unique per leg.

Estimated windows (estimates, not measurements; they scale the measured per-test cost and add the measured
setup). The parallel-safe pool cost 5.0 s per test on the 208-test shard and 6.4 s on the 184-test shard,
so a shard of about 131 tests is about 655 to 835 s plus roughly 100 to 130 s of setup, or 12.6 to 16 minutes.
The exclusive pool cost about 11 s per test including the failure timeouts, so a half of about 51 tests is
about 560 s plus 118 s of setup, or about 11 minutes. Specs are weighed by declared `test(` count, so the
real split can be uneven; a half 25% heavier than the other would still be about 13.5 minutes. Read the
`CAXRI_E2E_SHARD` summary line of the next run before adjusting further.

- `run-e2e-pools.ts --pool parallel-safe|desktop-exclusive` reads `--shard <i>/<N>` or `CAXRI_E2E_SHARD`. The partition
  lives in `scripts/e2e-pool-shard.ts`: specs are weighed by their declared `test(` calls and
  assigned longest-first to the lightest shard (name order breaks ties), so every runner derives the
  same split from the same checkout, each spec lands in exactly one shard, and a shard's receipt is
  validated against exactly the specs it was dispatched. Playwright's own `--shard` is not used: its
  per-shard listing needs `--reporter=json`, which the public log boundary
  (`scripts/__tests__/ci-e2e-log-safety.test.ts`) keeps out of repository scripts. Census reruns are
  unaffected.
- The receipt keeps the pool name (`parallel-safe` or `desktop-exclusive`); each shard is its own runner, so the shard's
  `planned`, `started`, and `hash` describe that shard only. The shard prints
  `CAXRI_E2E_SHARD {"planned","pool","shard","specs"}` with its planned test count after the pool
  ends, and the step summary labels the pool row with its shard. A cross-shard total is read by summing the shard
  manifests (`CAXRI_E2E_MANIFEST`) in the job logs.
- A `parallel-safe` shard leg writes `desktopExclusive: null` in its concurrent-validation receipt; an
  `exclusive` leg (`e2e` or the `e2e-parallel` include entry) writes `parallelSafe: null`. A `null` entry never satisfies a verification, and `verify parallel-safe`
  requires setup, the pool, and the manifest to be zero.
- The `ci` gate requires `e2e`, `e2e-parallel`, `e2e-perf`, and `checks-hosted-full` to succeed on
  the optimized full-scope `hosted-full` route (where `checks` is skipped) and requires the latter
  three to be skipped everywhere else.
- Artifact names are unique per leg: `e2e-parallel-safe-failure-artifacts-shard-<index>` per parallel-safe
  shard, `e2e-desktop-exclusive-failure-artifacts-shard-<index>` for the second exclusive half,
  `e2e-desktop-exclusive-failure-artifacts` for the exclusive leg in `e2e`, and the unchanged
  `renderer-performance-receipt` and `agent-chat-switch-performance-receipt` from `e2e-perf`.

The original single-window accounting follows. On the historical self-hosted runner the window held
`desktop-exclusive`, the dispatch-only CI parity cases (about 200s, one worker), `parallel-safe`,
and the manifest after the shared setup (about 45s), with a target of 85% of the deadline (21m15s).

On the historical self-hosted runner the window's floor was set by the checks branch: ESLint,
oxlint, Vitest, and the bundle budget finished about 15 minutes in on Actions run `38197586711`.
On the 3-core `macos-15` image that branch never finished. Cold ESLint beside the Electron pools
took 912 s with `concurrency=off`, 1170 s with `2`, and did not finish in 25 minutes with `auto`
(runs `41215993831`, `41220371428`, `41220368184`), so every optimized `hosted-full` dispatch aborted
before its performance gates ran ([issue caxri#1869](https://github.com/tjx666/caxri/issues/1869)).
The optimized route therefore keeps ESLint, Vitest, and the bundle budget in their own `lint`,
`unit`, and `bundle-budget` jobs, exactly as the automated full scope does, and the window's checks
branch runs only the remaining light gates, now in the Linux `checks-hosted-full` job rather than
inside the window. The CI gate requires those jobs on this route too.

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
2s, and `caxri-bot.e2e.ts` moved its two Workbench hand-off tests into
`caxri-bot-workbench-handoff.e2e.ts`, because `focusMainWindow()` then showed the Workbench and
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
matrix jobs. Those jobs did not run concurrently after CI moved to one physical self-hosted runner;
the runner queued them serially and each job repeated setup and build.

| Evidence                           | Exact head | Result                                                                               |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Control run `31661533997`          | `953c800`  | 99 passed, 5 skipped; one-worker suite 6.5m                                          |
| Split experiment `31663039930`     | `31dfe0e`  | 41 parallel-safe tests in 1.8m; 58 passed and 5 skipped exclusive tests in 4.3m      |
| Exact-head dispatch `31663792074`  | `544c775`  | all gates green; 41 tests in 2.1m and 58 passed/5 skipped in 5.4m                    |
| Ready PR failure `31664514393`     | `544c775`  | exposed a stale path-browser query wait; exclusive pool green                        |
| Ready PR failure `31665289454`     | `379ed75`  | exposed an ambiguous Monaco warmup locator; exclusive pool green                     |
| Draft focused checks `31667490248` | `7a0a836`  | runner allocation restored; focused source checks green, macOS intentionally skipped |
| Final ready PR `31668179503`       | `44e7801`  | all gates green; checks 2.3m, parallel-safe 4.3m, desktop-exclusive 6.9m             |

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

## Explicit full-E2E diagnosis contract

- A queued GitHub-hosted job is not successful evidence. Preserve the first red run and download its
  artifacts. Do not rerun a known red SHA or push
  one assertion fix at a time.
- Reproduce the exact failed spec against a fresh production build with one worker and
  `--repeat-each=3`. A `parallel-safe` failure must also be exercised under its namespaced
  multi-worker pool (CI runs three workers by default; `CAXRI_E2E_PARALLEL_WORKERS` accepts 2 to 4)
  so local validation matches CI scheduling pressure.
- Finish the complete repair batch and focused local gates before pushing once. Legacy `e2e-only`
  and `e2e-repair` trailers remain parseable only as compatibility metadata: they run full hosted
  checks and cannot start Playwright or reuse an ancestor receipt. Do not add them to new PRs.
- A failed explicit full-E2E candidate must be repaired against a new exact SHA. It is dispatched
  again only when the maintainer gives fresh authorization; ready-PR ancestor reuse is suspended
  while automatic PR E2E is disabled.
- Keep test counts, assertions, isolation, error gates, and content-safe failure receipts unchanged.
  Optimize fixture cost and orchestration rather than coverage.

## Current CI decision matrix

The policy evaluates legacy retry hints first, but every accepted hint resolves to full hosted
checks with no E2E. Current PR plans never request E2E, so ancestor lookup remains dormant and
cannot reduce current-head validation. Missing, malformed, stale, or unverifiable metadata fails
closed to the event's ordinary hosted-check row.

`mode` belongs to `RetryPolicyDecision`; the remaining three values belong to
`CIExecutionPlan`. The table is a behavior map, not a second implementation of the state machine.

| Input and validated precondition                                                       | `mode`       | `checksScope`               | `e2eProfile`                | `runE2E`       |
| -------------------------------------------------------------------------------------- | ------------ | --------------------------- | --------------------------- | -------------- |
| Legacy unchanged-tree PR retry metadata                                                | `e2e-only`   | `full`                      | `control`                   | no             |
| Legacy modified-existing-spec repair metadata                                          | `e2e-repair` | `full`                      | `control`                   | no             |
| Product, shared E2E support, protected, unknown, or spec-add/delete repair delta       | `full`       | Continue with the event row | Continue with the event row | event row      |
| Missing or rejected retry evidence                                                     | `full`       | Continue with the event row | Continue with the event row | event row      |
| `workflow_dispatch`, target `checks-only`                                              | `full`       | `full`                      | `control` / `optimized`     | no             |
| `workflow_dispatch`, target `hosted-smoke`                                             | `full`       | `full`                      | `control`                   | targeted smoke |
| `workflow_dispatch`, target `hosted-full`, freshly authorized by the maintainer        | `full`       | `full`                      | `control` / `optimized`     | explicit only  |
| PR documentation only                                                                  | `full`       | `focused-docs`              | `control`                   | no             |
| PR repository-skill and documentation only                                             | `full`       | `focused-skills`            | `control`                   | no             |
| Draft PR with any remaining source change                                              | `full`       | `focused-source`            | `control`                   | no             |
| Ready PR whose delta touches a full-validation path or has a malformed E2E declaration | `full`       | `full`                      | `optimized`                 | no             |
| Ready PR with any remaining source change                                              | `full`       | `affected`                  | `focused`                   | no             |
| Non-release `push` containing only documentation or repository skills                  | `full`       | `full`                      | `optimized`                 | no             |
| Non-release `push` with product, test, workflow, or unknown delta                      | `full`       | `full`                      | `optimized`                 | no             |
| Exact `release:prepare` output; PR CI passed                                           | `full`       | `skipped`                   | `control`                   | no             |
| Unknown or missing event                                                               | `full`       | `full`                      | `control`                   | no             |

The pure retry, execution-plan, and green-reuse evaluators each have focused tests. The ordered
GitHub lookup and `main` orchestration glue remain fail-closed but do not have a direct IO-level
unit test; this is accepted while no concrete glue regression justifies extracting or mocking that
boundary. Adding a new decision dimension must update the pure policy tests and this matrix before
changing workflow wiring.

## Hosted checks and explicit E2E

A ready source PR runs on disposable `macos-15` ARM64 runners. `scripts/ci-execution-plan.ts`
routes it to the `affected` scope:

- **Checks**: changed-file lint, repository typecheck, and knip through `bun run check`.
- **Unit**: `vitest related --run` over the changed sources, split into three `--shard` jobs that run
  beside `checks` instead of after it (`scripts/run-ci-unit-tests.ts`). `related` walks the whole
  import graph, so a change in a shared package reaches every suite that transitively imports it.
  The `full` scope shards the complete suite the same way, moves ESLint to a Linux `lint` job, and
  `checks` runs `scripts/ci-platform-checks.ts --skip-vitest --skip-eslint --skip-bundle-budget`
  on Linux, with the bundle budget in its own macOS job. The CI gate requires
  every shard whenever `checks` runs either scope, and `lint` whenever it runs `full`.
- **E2E selection**: the union of specs declared in the PR body with one
  `CI-E2E-Tests: ["e2e/example.e2e.ts"]` line, ordinary specs the PR changed, and specs that directly
  import a changed source file. The selection is recorded for an explicit validation dispatch; a PR never starts
  full E2E automatically. Protected specs (performance, real Agent, failure isolation) remain excluded.
- **Full hosted-check fallback**: a delta that touches a retry-protected path (workflows, CI
  runners, `e2e/support/**`, toolchain files) or any workspace `package.json`, `tsconfig*.json`,
  `vite`/`vitest`/`electron.vite`/`playwright` config, or `patches/**` routes the hosted macOS
  `checks` job to the `full` checks scope. A malformed or protected `CI-E2E-Tests` declaration does
  the same. This expands hosted platform checks only; `runE2E` remains false and an explicit
  dispatch still owns every full E2E run.

Bundle budgets run in the `full` checks scope on hosted macOS. Knip runs in both the `full` and
`affected` scopes, so an unused export fails a ready source PR before merge. Knip is
repository-wide but measured at about 3 s locally (warm cache), cheap enough to add to `affected`
without a separate job or a change to the required `guards` job. React Doctor (`doctor:changed`)
runs in `full` and, for the same reason, in `affected` whenever the diff touches a Desktop or
Mobile script module: it scans only the changed files against the PR base, in about 4 s on a
hosted runner. Left to the `full` scope alone, a PR's new warnings passed its own CI and turned the
`main` push red after merge. Ordinary pushes to `main` run the
`full` checks but do not start full E2E. There is no scheduled full E2E.

`hosted-smoke` is the repeatable hosted desktop launch and runs only `e2e/smoke.e2e.ts`. That spec
does not request clipboard access, so this one disposable GitHub-hosted route explicitly skips the
local focused-run clipboard snapshot. The launch policy rejects that override off GitHub-hosted CI
or for a clipboard-capable launch. Current publication-readiness evidence is the complete hosted
unit/integration suite, build and native checks, package validation, targeted Electron smoke, and
the hosted no-publish Release rehearsal.
Full E2E is deliberately not a runner-removal, GO, repository-publication, Release, or
anonymous-review gate. `hosted-full` on `macos-15` remains available only as a future manual
diagnostic route, and every dispatch or retry requires fresh, explicit maintainer authorization.
Hosted E2E must collect a separate calibration before it can enforce the historical
machine-specific Renderer performance baseline.

The Release workflow's manual dispatch is a no-publish rehearsal. Because it runs on `main`, it
also seeds the Gradle cache the next release restores. It keeps the Linux x64/ARM64 native matrix,
then uses `macos-15` ARM64 to install the exact Node, pnpm, Bun, JDK 17, Android
Platform 36, Build Tools 35/36, NDK, and CMake versions. It signs the Android rehearsal APK with an
ephemeral one-run key, packages both unsigned DMG flavors, and runs the two targeted packaged-app
smoke specs against the canonical Source Map flavor. It has read-only repository permission, reads
no secrets, uploads no DMG, and never creates a GitHub Release.

### Wall-clock layout

Measured before the split on hosted `macos-15` (2026-10-22): an `affected` PR spent about 4.4 minutes in
`bun run check` and then 11 minutes in `vitest related`; a `main` push spent 27 minutes serially in
ESLint (642 s), Vitest (585 s), and the remaining gates; a release spent 31.5 minutes, 19 of them in a
cold Android Gradle build that only started after the Linux natives finished. The current layout:

- `retry-policy` runs on `ubuntu-latest`. It only reads Git history and the Actions API, and the
  account's concurrent macOS runners are the scarce resource that queues `checks` and `unit`.
- Vitest runs in three `unit` shards beside `checks`. The full scope runs `checks` on
  `ubuntu-latest`, where setup and oxlint measured 18 s and 31 s against 50 s and 85 s on macOS.
  The bundle budget packages a macOS `dir` build, so it runs alone in a short `bundle-budget` job on
  `macos-15`. Every extra shard repeats about 80 seconds of setup. With two shards the
  main push measured `checks` 8.8 minutes and the slower shard 8 minutes; focused scopes keep
  `checks` on macOS because their changed-file tests may load native modules.
- Full-scope ESLint runs in a `lint` job on `ubuntu-latest` with `--concurrency auto`, beside
  `checks`. It installs without lifecycle scripts, so no native module is involved, and it does not
  count against the macOS concurrency limit. Locally a full lint took 93 s serially and 41 s with
  four workers. The job restores a main-seeded ESLint cache keyed on the lockfile,
  `eslint.config.ts`, and `scripts/eslint-rules/**`. ESLint has no type-aware rules, so the
  content-hashed cache stays sound. The hosted full-E2E route still runs ESLint inside the
  platform checks.
- `@yutengjing/no-declare-implicit-any-var` is replaced by the local `caxri/no-declare-implicit-any-var`.
  Upstream probed four Vue packages through `local-pkg` once per linted file, which was 46% of ESLint
  time; dropping the probe cut a `packages` plus `apps/server` lint from 88 s to 35 s locally.
- The first split run measured both `unit` shards at about 6.5 minutes, while `checks` without
  Vitest still took 18 minutes: a cold 702 s ESLint, then oxlint (71 s), typecheck (3.5 minutes), and
  the bundle budget gate (83 s). With the rule port, macOS ESLint still took 565 s, which is why
  ESLint moved to its own Linux job.
- Vitest's `fsModuleCache` is not persisted: a warm cache measured no faster than a cold one
  locally, because import time is module evaluation rather than transformation.
- The Release workflow builds the Android update bundle in its own `android-bundle` job, in parallel
  with `linux-natives`, and restores a Gradle home cache with the build cache enabled. The
  publishing job downloads the bundle and still compares it byte for byte with both Desktop flavors.
  With the Gradle cache warm (v0.0.128), the Android build took 10 minutes against 18.8 cold, and
  the release finished 19.7 minutes after its trigger. About four of those minutes were CMake
  compiles the Gradle build cache does not cover, so the shared setup routes CMake through a per-run
  `ccache` cache: with a warm cache, the build reached R8 in 5.1 minutes instead of 6.4 in a
  rehearsal, and in 4.9 minutes in the v0.0.129 release, which finished 18.6 minutes after its
  trigger. A 4 GiB Gradle heap did not shorten R8 (3.6 minutes at 2 GiB, then 3.7 and 5.7 at
  4 GiB), so the project heap stays.
- `scripts/ci-platform-gates.ts` marks the gates that need macOS (`vitest`, `bundle-budget`). A
  contract test requires the Linux full-scope `checks` command to skip each of them, and
  `ci-platform-checks.ts` refuses such a selection off macOS before any gate runs.

## Explicit full-E2E dispatch contract

- Automatic pull-request and `main`-push events stop at the hosted `retry-policy` and `checks` jobs.
  They never enter the `e2e` job, including when `checksScope` is `full` or `e2eProfile` is
  `optimized`.
- An explicitly authorized `hosted-full` dispatch checks out the dispatched SHA. With
  `e2e_profile: optimized`, the platform checks other than ESLint, Vitest, and the bundle budget
  (those keep their own jobs) run in the Linux `checks-hosted-full` job on that same SHA, beside the
  exact-head E2E legs. There is no PR synthetic-merge or `main`-push E2E path.
- Exact-head E2E verifies native modules and builds once, then runs `desktop-exclusive` with one
  worker, the dispatch-only CI-parity cases, and `parallel-safe` with three namespaced workers. The
  `hosted-full` route runs the same orchestration on `macos-15`. The `workflow_dispatch` worker input
  remains bounded to 2–4 for frozen same-head comparisons.

### Four parallel workers, measured and rejected

The obvious next step after the pool stopped competing with the checks branch was a fourth worker,
and the receipt says it does not pay. Two same-branch runs, identical except for the worker count:

| Workers           | Serial spec time | Wall   | Workers busy | Cost per test | `parallel-safe` failures |
| ----------------- | ---------------- | ------ | ------------ | ------------- | ------------------------ |
| 3 (`35555168511`) | 1218.5s          | 416.4s | 2.93 / 3     | None          | 1                        |
| 4 (`35557167068`) | 1444.5s          | 371.2s | 3.89 / 4     | **+18.5%**    | 2                        |

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

- Every authorized `hosted-full` run still executes the fixed Renderer performance scenario and
  uploads its machine-readable receipt. Those fixed same-run thresholds remain part of that run.
  The historical self-hosted cross-run baseline is `armed: false` and cannot block hosted E2E;
  enough same-image GitHub-hosted receipts must establish a replacement before rearming it. The
  manually dispatched trend comparison is likewise non-blocking until that hosted baseline exists.
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
- Before an Actions upload, `scripts/prepare-public-e2e-receipts.ts` reads only the fixed internal
  receipt filenames and atomically writes a strict public projection under
  `test-results/public-receipts/`. The projection removes titles, test IDs, artifact paths,
  timestamps, and arbitrary error text. It retains a stable error hash when available and otherwise
  emits the closed `missing-error` classification, so each failed or timed-out test remains visible.
  Workflow upload paths name individual JSON files: raw Playwright output, progress journals, traces,
  screenshots, DOM snapshots, Terminal content, and auxiliary receipts never leave the disposable
  hosted runner.
- GitHub-hosted Playwright commands use `scripts/reporters/public-e2e-reporter.ts`. It emits only
  repository-relative locations, closed statuses and failure phases, protocol error counts,
  bounded startup timings, and run state. Dedicated diagnostic annotations are sanitized before
  writing and revalidated by `scripts/reporters/public-e2e-diagnostics.ts`. Test titles, error text,
  source snippets, arbitrary annotations, attachments, worker stdout/stderr, DOM values, and Terminal
  values are deliberately absent from the public Actions log. Local focused reproduction keeps the
  normal detailed reporter.
- Every required output is checked before every launch. Each Playwright worker performs one full
  recursive build-input scan, then reuses it until a filesystem event or mtime snapshot invalidates
  the cache; watcher failure falls back to scanning.
- The concurrent orchestrator writes one versioned receipt once its E2E component finishes.
  Independent parallel-safe and desktop-exclusive verifier steps bind that receipt to the Actions
  run attempt, platform-check revision, exact head, profile, and worker count; a missing, stale, malformed, or non-zero component fails closed.
- Focused checks, `checks-only` and `hosted-smoke` dispatches, one-worker controls, and non-optimized
  profiles keep their standalone paths. Only an explicitly authorized optimized `hosted-full`
  dispatch can replace the standalone checks job with the concurrent path (the Linux `checks-hosted-full` job); `lint`, `unit`, and
  `bundle-budget` still run beside it, and `e2e-parallel` and `e2e-perf` take the sharded pool and the
  performance gates off that window (see the 25-minute budget section).
- Vitest defaults to the audited `optimized` partition and two workers in the sharded `unit` job,
  which runs on every full scope, including the optimized `hosted-full` route. The `legacy` partition and worker caps 1-4 remain
  workflow-dispatch controls for same-head measurement; real watcher, process-global, bridge, and
  Git suites stay in `serial-native`.

## Performance regression baseline

The fixed thresholds `renderer-performance` asserts catch a large, sudden regression but never a
steady creep: a change that costs 3% every time never crosses a fixed number. `Run Renderer
performance baseline gate` runs immediately after that step and additively compares the same
receipt against a noise-derived, committed baseline, `scripts/performance-baseline.json`. During
the hosted transition that baseline is `armed: false`: the comparison remains visible but cannot
fail the job. A separately dispatched [Gradual-creep trend check](#gradual-creep-trend-check) is
also non-blocking until enough same-image hosted receipts support a newly reviewed baseline. The
fixed threshold, cross-run comparison, and trend report remain independent surfaces.

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

`benchmark:chat-switch` runs in the same job right after `benchmark:renderer`, on its profiling
build, and `Run Agent Chat switch performance baseline gate` compares its receipt against
its own `performance-baseline.agent-chat-switch.json` under `scripts/` the same way. That baseline does not exist yet,
so the step records `no-baseline` until enough same-image `agent-chat-switch-performance-receipt`
artifacts are collected, derived, reviewed, and armed. The benchmark adds one Electron launch of about
two minutes to the job; see
[Agent Chat Session switch](renderer-performance.md#agent-chat-session-switch).

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

The current file is intentionally `armed: false` because its samples came from the retired
self-hosted pool. Do not rearm it from local samples or a mixed runner population. Collect enough
`hosted-full` receipts from the same GitHub-hosted image, review the derived thresholds, and rearm it
in a separate change.

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

### Historical runner-baseline procedure

The retired self-hosted route collected `renderer-performance-receipt` artifacts without direct
runner access. The commands below preserve how the historical baseline was derived. Reinstating an
automated GitHub-hosted cross-run gate requires a separately reviewed calibration from enough
same-image `hosted-full` samples
(`RECOMMENDED_MINIMUM_RUNNER_SAMPLE_COUNT`, 40, or more for a stable maximum):

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

The committed `scripts/performance-baseline.json` records that retired machine's evidence with
`armed: false`; its `source: "runner"` field does not authorize applying those thresholds to a
GitHub-hosted run. Never hand-edit the JSON file; a future hosted baseline must be derived from its
own reviewed same-image sample window.

The receipt artifacts expire after seven days. The content-safe public reporter suppresses worker
stdout, including the full `CAXRI_RENDERER_BENCHMARK` payload, so a future baseline sample window must
be downloaded before expiry. The 98 historical self-hosted receipts predate that boundary and were
reconstructed from their old logs; that recovery path is historical evidence, not the current
contract. Before committing a new baseline, confirm the derivation reproduces every unchanged metric
of its reviewed downloaded sample set. The historical `frames.sampleCount` exclusion was applied by
reconstructing those 98 old receipts and reproducing all 60 previously gated metrics, so the
regenerated file differed only by that metric's move to `excluded`, `recordedAt`, and `commit`.

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
separate from `ci.yml`'s Apple Silicon jobs, since it needs no Electron launch and no build. It
triggers only through an explicit `workflow_dispatch` with optional `window` and `alarm_ratio`
overrides (never `schedule` or `pull_request`), so it costs no full-E2E runner time and stays out of
the required PR guards. While the baseline is unarmed, the workflow is a non-blocking diagnostic.
With `permissions: actions: read`, it lists the most recent
`renderer-performance-receipt` artifacts via `gh api .../actions/artifacts`, downloads each with
`gh run download`, and runs `bun run performance:trend:check -- --baseline
scripts/performance-baseline.json --receipts-dir <dir> --window <N> --alarm-ratio <X>`, which writes
its table to the job's step summary and exits non-zero on `alarm`.

### Per-run comparison scope

`Run Renderer performance baseline gate` compares only when `CI_CHANGED_FILES` (the same
`needs.retry-policy.outputs.changed_files` the `checks` job already reads) intersects
`isPerformanceRelevantPath`: Desktop main/preload/renderer source, Server source, the shared
Client/protocol/system packages, a performance E2E spec, or the baseline's own script/JSON files.
An unrelated change (docs, an extension, a CLI-only fix) never pays for a comparison that cannot
regress what the baseline measures. Outside CI, or when there is no changed-files signal to reason
about at all, the gate always compares: an operator running it by hand wants a real answer, not a
skip. The trend check has no such scoping: its explicitly dispatched run always compares.

### Cost

The gate step reads two small JSON files and does no build or Electron launch; its own cost is
sub-second. It is gated on `renderer-performance` having produced a receipt at all (`if: always()
&& steps.renderer-performance.outcome != 'skipped'`), so it adds no new build, no new Electron
launch, and no new CI minutes beyond that near-instant read-and-compare. The trend check's own
GitHub-hosted job cost is likewise near-instant (an artifact list, a handful of small downloads, and
one JSON comparison) and never occupies a full-E2E job.

## Comparison contract

Freeze exact head, manifest, Node/pnpm versions, lockfile hash, runner label, workflow inputs, cache
state, and counts before comparing profiles. Report median end-to-end wall time, dominant steps,
peak process-tree RSS, cache state, and every non-green attempt. Adopt a parallelism or concurrency
change only when correctness and isolation stay green and same-image GitHub-hosted medians improve;
otherwise
restore control and record the rejection. `CAXRI_VALIDATION_ENV`, `CAXRI_CACHE_STATE`,
`CAXRI_CI_METRIC`, `CAXRI_E2E_MANIFEST`, and the downloaded `renderer-performance-receipt` artifacts
provide the machine-readable inputs for that report;
the owning issue or PR records the candidate-specific samples and adoption decision.

Before dispatch, freeze the sample count, dispatch order, expected minimum wall time from the most
recent same-runner result, and stop condition. A median comparison normally means three control and
three candidate samples; queue that frozen set once, record run ids immediately, and do not replace
red samples unless a documented unrelated infrastructure failure invalidated them. Tell the user
that lower bound before the runner is occupied. Stop after the declared set and generate one report
from the recorded metrics rather than extending the experiment with manually assembled evidence.

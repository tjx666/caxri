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
- Finish the complete repair batch and focused local gates before pushing once. Use exact-tree
  `e2e-repair` for an eligible unprotected delta. Workflow, dependency, pool, fixture, and retry
  policy changes remain fail-closed and require one final full run.
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

`mode` belongs to `RetryPolicyDecision`; the remaining three values belong to
`CIExecutionPlan`. The table is a behavior map, not a second implementation of the state machine.

| Input and validated precondition                                                    | `mode`                    | `checksScope`               | `e2eProfile`                        | `runE2E`       |
| ----------------------------------------------------------------------------------- | ------------------------- | --------------------------- | ----------------------------------- | -------------- |
| Eligible exact-tree PR retry                                                        | `e2e-only` / `e2e-repair` | `skipped`                   | `control`                           | yes            |
| Missing or rejected retry evidence                                                  | `full`                    | Continue with the event row | Continue with the event row         | event row      |
| `workflow_dispatch`, profile `skip` / `control` / `optimized`                       | `full`                    | `full`                      | `control` / `control` / `optimized` | no / yes / yes |
| PR strict-ancestor full-green reuse; delta is documentation only                    | `full`                    | `focused-docs`              | `control`                           | no             |
| PR strict-ancestor full-green reuse; delta includes only `go` / `acceptance` skills | `full`                    | `focused-skills`            | `control`                           | no             |
| PR documentation only                                                               | `full`                    | `focused-docs`              | `control`                           | no             |
| PR repository-skill and documentation only                                          | `full`                    | `focused-skills`            | `control`                           | no             |
| Draft PR with any remaining source change                                           | `full`                    | `focused-source`            | `control`                           | no             |
| Ready PR with any remaining source change                                           | `full`                    | `full`                      | `optimized`                         | yes            |
| Non-release `push` containing only documentation or repository skills               | `full`                    | `full`                      | `optimized`                         | no             |
| Non-release `push` with product, test, workflow, or unknown delta                   | `full`                    | `full`                      | `optimized`                         | yes            |
| Exact release commit                                                                | `full`                    | `full`                      | `control`                           | yes            |
| Unknown or missing event                                                            | `full`                    | `full`                      | `control`                           | yes            |

The pure retry, execution-plan, and green-reuse evaluators each have focused tests. The ordered
GitHub lookup and `main` orchestration glue remain fail-closed but do not have a direct IO-level
unit test; this is accepted while no concrete glue regression justifies extracting or mocking that
boundary. Adding a new decision dimension must update the pure policy tests and this matrix before
changing workflow wiring.

## Current single-runner execution contract

- A full ready-PR or `main` run installs once in the E2E checkout. Inside the concurrent validation
  window it also creates and installs an owned disposable checkout for the platform-check revision:
  GitHub's synthetic merge on a PR, or the exact push on `main`. Checkout preparation and the
  unchanged full platform gates overlap exact-head E2E. The platform gates keep their original
  fail-fast order, while E2E still attempts both pools and the manifest even if another validation
  surface fails.
- Exact-head E2E verifies native modules and builds once. It then runs `parallel-safe` with three
  namespaced workers followed by `desktop-exclusive` with one worker on the same `m2-24`; a failed
  first pool does not suppress the second pool. The `workflow_dispatch` worker input stays bounded
  to 2–4 for frozen same-head comparisons.
- Individually audited tests may move into a dedicated spec in the `parallelSafeSpecs` allowlist.
  Every unclassified spec remains desktop-exclusive, so each logical pool needs only one
  Playwright invocation.
- The Playwright invocation itself writes each pool receipt. Receipts distinguish planned,
  started, finished, passed, skipped, and failed tests; their verified union supplies the manifest
  hash without a separate `playwright --list` collection. CI logs the verified union as
  `CAXRI_E2E_MANIFEST` JSON.
- Every required output is checked before every launch. Each Playwright worker performs one full
  recursive build-input scan, then reuses it until a filesystem event or mtime snapshot invalidates
  the cache; watcher failure falls back to scanning.
- The concurrent orchestrator writes one versioned receipt only after both validation branches
  finish. Independent checks, parallel-safe, desktop-exclusive, and auxiliary verifier steps bind
  that receipt to the Actions run attempt, platform-check revision, exact head, profile, and
  worker count; a missing, stale, malformed, or non-zero component fails closed.
- Focused checks, one-worker controls, retry-only runs, and non-full profiles keep their standalone
  paths. Only a full optimized run can replace the standalone checks job with the concurrent path.
- Vitest defaults to the audited `optimized` partition. Automatic standalone checks use two
  workers; the concurrent full path uses one so the complete Vitest suite leaves CPU headroom for
  three Electron workers on the same runner. The `legacy` partition and worker caps 1-4 remain
  workflow-dispatch controls for same-head measurement; real watcher, process-global, bridge, and
  Git suites stay in `serial-native`.

## Comparison contract

Freeze exact head, manifest, Node/pnpm versions, lockfile hash, runner label, workflow inputs, cache
state, and counts before comparing profiles. Report median end-to-end wall time, dominant steps,
peak process-tree RSS, cache state, and every non-green attempt. Adopt a parallelism or concurrency
change only when correctness and isolation stay green and self-hosted medians improve; otherwise
restore control and record the rejection. `CAXRI_VALIDATION_ENV`, `CAXRI_CACHE_STATE`,
`CAXRI_CI_METRIC`, and `CAXRI_E2E_MANIFEST` provide the machine-readable inputs for that report;
the owning issue or PR records the candidate-specific samples and adoption decision.

Before dispatch, freeze the sample count, dispatch order, expected minimum wall time from the most
recent same-runner result, and stop condition. A median comparison normally means three control and
three candidate samples; queue that frozen set once, record run ids immediately, and do not replace
red samples unless a documented unrelated infrastructure failure invalidated them. Tell the user
that lower bound before the runner is occupied. Stop after the declared set and generate one report
from the recorded metrics rather than extending the experiment with manually assembled evidence.

# CI and E2E Performance Evidence

This is the single source of truth for CI optimization decisions. It records comparable hosted
evidence, non-green attempts, correctness constraints, and cost controls. A failed path is useful
failure-cost data, but it is never a green performance baseline.

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

## Adopted optimization evidence

The optimized workflow rebuilds only `better-sqlite3` and `node-pty`; `@parcel/watcher` uses its
Node-API platform package and remains covered by `spike:native`. It keeps the full Vitest manifest
while replacing production-sized waits and buffers with injected test seams. Playwright is split
into an explicit two-worker `parallel-safe` allowlist and a one-worker `desktop-exclusive`
remainder on separate macOS runners.

| Evidence                                                                         | Exact head | Result                                                                               |
| -------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| [Control run](https://github.com/tjx666/caxri/actions/runs/31661533997)          | `953c800`  | 99 passed, 5 skipped; one-worker suite 6.5m                                          |
| [Split experiment](https://github.com/tjx666/caxri/actions/runs/31663039930)     | `31dfe0e`  | 41 parallel-safe tests in 1.8m; 58 passed and 5 skipped exclusive tests in 4.3m      |
| [Exact-head dispatch](https://github.com/tjx666/caxri/actions/runs/31663792074)  | `544c775`  | all gates green; 41 tests in 2.1m and 58 passed/5 skipped in 5.4m                    |
| [Ready PR failure](https://github.com/tjx666/caxri/actions/runs/31664514393)     | `544c775`  | exposed a stale path-browser query wait; exclusive pool green                        |
| [Ready PR failure](https://github.com/tjx666/caxri/actions/runs/31665289454)     | `379ed75`  | exposed an ambiguous Monaco warmup locator; exclusive pool green                     |
| [Draft focused checks](https://github.com/tjx666/caxri/actions/runs/31667490248) | `7a0a836`  | runner allocation restored; focused source checks green, macOS intentionally skipped |

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

## Cost and diagnosis contract

- After a zero-step billing or spending-limit failure, dispatch `CI` with `runner_probe=true`.
  The probe runs only `retry-policy` on Ubuntu. Do not use `e2e_profile=skip`, which still runs full
  Linux checks. A green probe permits one paid macOS attempt for the same frozen head.
- Preserve the first red hosted run and download its artifacts. Do not rerun a known red SHA or push
  one assertion fix at a time.
- Reproduce the exact failed spec against a fresh production build with one worker and
  `--repeat-each=3`. A `parallel-safe` failure must also be exercised under its namespaced
  two-worker pool so local validation matches hosted scheduling pressure.
- Finish the complete repair batch and focused local gates before pushing once. Use exact-tree
  `e2e-repair` for an eligible unprotected delta. Workflow, dependency, pool, fixture, and retry
  policy changes remain fail-closed and require one final full run.
- After one ready-PR run has full Linux checks, every E2E pool, and `CI gate` green, a later strict
  ancestor may reuse that macOS evidence only when its entire delta is documentation or the
  repository-owned `acceptance`/`go` skill. The current head still runs focused Linux checks;
  product, workflow, dependency, fixture, pool, and other skill changes fail closed to full CI.
- Keep test counts, assertions, isolation, error gates, and failure artifacts unchanged. Optimize
  fixture cost and orchestration rather than coverage.

## Comparison contract

Freeze exact head, manifest, Node/npm versions, lockfile hash, runner label, workflow inputs, cache
state, and counts before comparing profiles. Report median end-to-end wall time, dominant steps,
peak process-tree RSS, billed whole minutes, cache state, and every non-green attempt. Adopt a
parallelism or concurrency change only when correctness and isolation stay green and hosted medians
improve; otherwise restore control and record the rejection.

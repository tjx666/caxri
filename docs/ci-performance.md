# CI Performance Evidence

This document keeps CI optimization claims tied to comparable hosted evidence. A failed path is
useful failure-cost data, but it is never a green performance baseline.

## Control run

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

The two green E2E jobs vary by almost two minutes on the same head. No absolute green target is set
from that sample. Attempts 3–5 also show why a nominal third control rerun cannot be called green:
`mutations.integration.test.ts` attached its rejection assertion after advancing a fake deadline,
so a fast rejection could be reported as unhandled before the assertion observed it. The optimized
head registers that handler before advancing time and must produce three hosted green attempts
before the final comparison is reported on the issue.

## Optimization contract

- Pin npm to the repository's declared version and cache npm downloads by OS, architecture, Node,
  npm, and lockfile rather than caching native `node_modules` output.
- Cache Electron downloads independently. Cache ESLint and Prettier only behind their relevant
  configuration hash, using content-based invalidation.
- Run native watcher and process-global Vitest files in a serial project while allowing isolated
  files at most two workers. Keep the test manifest visible in hosted output.
- Keep Playwright at one worker until desktop-global fixtures have per-worker isolation. Stop a red
  run after three primary failures and retain failure-only evidence for seven days.
- Permit new-head `e2e-only` or `e2e-repair` only with exact PR, base, workflow, ancestor, and tree
  provenance. A focused repair pass always continues to the complete suite on success.

For optimized comparisons, report the median job and dominant-step durations, billed whole
minutes, cache hit state, test counts, and every non-green attempt. Do not compare different test
manifests as if they were equivalent.

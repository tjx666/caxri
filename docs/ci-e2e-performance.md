# CI and E2E Performance Evidence

Issue #116 keeps optimization claims separate from implementation. A green run proves correctness;
it does not prove a speedup until the comparable hosted matrix below is complete.

## Frozen comparison

Before collecting samples, record the exact head, test manifest, Node/npm versions, lockfile hash,
runner labels, workflow inputs, cache state, and test count. Do not remove tests, weaken assertions,
or omit non-green attempts from the report.

Run the `CI` workflow manually with these inputs:

- Control: `e2e_profile=control`, `eslint_concurrency=off`.
- Optimized: `e2e_profile=optimized`, with the adopted ESLint candidate.
- ESLint A/B: keep `e2e_profile=skip` and run `eslint_concurrency=off`, `2`, and `auto` against the
  same hosted manifest.

Collect at least three green control samples and three green optimized samples. The workflow summary
reports npm, Electron, and quality-cache state plus wall time and peak process-tree RSS for pinned
npm installation, registry/unpack/link, Electron download, native rebuild, ESLint, and Playwright.

## Evidence matrix

| Acceptance item        | Evidence                                                        | Status                                            |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Three control greens   | Run URLs, exact heads, counts, non-green attempts               | Pending hosted runs                               |
| Three optimized greens | Run URLs, exact heads, counts, non-green attempts               | Pending hosted runs                               |
| Pool integrity         | `@parallel-safe` + `@desktop-exclusive` manifest summary        | Implemented locally                               |
| Worker interruption    | Replacement namespaced lease and subsequent exclusive pool      | Implemented locally; pending optimized hosted run |
| Hosted parity          | Four deterministic cases through `scripts/run-hosted-parity.ts` | Implemented locally; pending hosted dispatch      |
| Retry modes            | Real `e2e-only` and `e2e-repair` run URLs and fallback cases    | Pending hosted runs                               |
| Cache                  | Cold/warm hit state and phase-separated install timing          | Implemented locally; pending hosted runs          |
| ESLint                 | `off` / `2` / `auto` wall time and peak RSS                     | Implemented locally; pending hosted runs          |
| Trigger policy         | docs, skill-only, draft, ready, main, and release receipts      | Implemented locally; pending hosted runs          |

## Adopt or reject

Compare median end-to-end wall time and billed Linux/macOS minutes, not a single local step. Adopt
two-worker pooling or an ESLint concurrency setting only when all tests remain present, isolation is
green, peak memory is acceptable, and hosted medians improve. Otherwise restore the control setting
and record `reject` with the run URLs and regression reason.

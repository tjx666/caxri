# Bundle size baseline and budget gate

Caxri ships a packaged macOS app whose size is protected by a CI gate. This document records the
optimized baseline, the rules that keep it small, and how to analyze and re-budget when a change
legitimately needs more bytes.

## Baseline (2026-08, arm64 dir target)

| Artifact                  | Size      | Dominant contents                                                   |
| ------------------------- | --------- | ------------------------------------------------------------------- |
| `Caxri.app` (total)       | ~406 MiB  | Electron 43 framework + embedded standalone Server                  |
| `Resources/server`        | ~123 MiB  | Pinned runtime (~116 MiB), native dependencies, bundles, extensions |
| `app.asar`                | ~36 MiB   | Desktop Main, Preload, and Renderer bundles                         |
| `out/renderer`            | ~35.4 MiB | Monaco (~6.8 MiB JS + 15 MiB workers), fonts, vscode-icons (below)  |
| `out/main`                | ~650 KiB  | Electron Desktop Main only                                          |
| `out/preload`             | ~8 KiB    | Sandboxed preload bundles                                           |
| `apps/server/dist/server` | ~123 MiB  | Byte-identical source of the embedded Server artifact               |

The renderer carries the full `@yutengjing/vscode-icons` SVG set (~4.5 MiB across 1553 files,
emitted as individual assets). This is a conscious budget increase, not drift: the Files secondarySidebar
can encounter any file or folder name in a user's project at runtime, so there is no meaningful
subset to tree-shake, and shipping the complete set is what makes icons match VS Code's
vscode-icons extension.

Pre-optimization the app was ~367 MiB on disk: 220 Electron locales (47 MiB), whole-package
`node_modules` copies in the asar (drizzle-orm 14 MiB, zod 5.7 MiB, xterm 5 MiB, archiver's
transitive tree ~7 MiB), multi-platform native prebuilds and sqlite source (~26 MiB), and a
1024px primarySidebar logo (0.5 MiB).

## Rules that keep the package small

1. **The root has no production dependencies.** Desktop pure JavaScript is bundled into `app.asar`;
   Server dependencies are assembled only inside `apps/server/dist/server`.
2. **The standalone Server owns its runtime.** Desktop and platform deployments copy the same
   manifest-bound directory, including the pinned runtime, native dependencies, migrations, and
   extensions. The budget gate verifies both copies and loads all three Server entry points using
   that runtime.
3. **Native packages ship selected runtime inputs only.** The artifact builder excludes unrelated
   platform prebuilds and C/C++ source trees while preserving executable helper modes.
4. **Electron locales are pruned** to `electronLanguages` (en, en_GB, zh_CN, zh_TW).
5. **Renderer assets match their display size** (the primarySidebar logo is 128px, not the 1024px icon
   source). Monaco and its language workers (`ts.worker` ~11 MiB) are a deliberate product cost
   for editor IntelliSense; they load lazily at runtime but ship in full.

## Analyzing the bundle

```bash
CAXRI_BUNDLE_ANALYZE=1 bun run build:desktop
```

Writes interactive HTML + JSON [Sonda](https://sonda.dev) reports per process under
`.cache/bundle-analysis/` (source maps are enabled automatically for accurate package
attribution). Use the JSON report to aggregate bytes per npm package or find modules duplicated
across chunks.

## The CI budget gate

`scripts/ci-bundle-budget.ts` (wired into the `checks` job of `.github/workflows/ci.yml`) runs a
timed build, a timed `electron-builder --mac dir` packaging pass, the packaged module-resolution
artifact integrity and entry-point probe, and asserts every artifact stays under its byte budget. Budgets are absolute ceilings with
headroom over this baseline — when the gate fails, first try to optimize the regression away;
only consciously raise the budget in `scripts/ci-bundle-budget.ts` and update this document in
the same PR.

### Job summary and baseline deltas

Every gate run appends a Markdown report to the GitHub Actions job summary: phase timings and a
component-level size breakdown (Electron runtime, asar, standalone Server runtime/native/bundles,
each Desktop `out/` surface, and the Renderer Monaco workers and fonts), each with its
budget and a percentage delta. Because the project has no public release yet, the comparison
baseline is the last green `main` build: a green `main` run stores its measurements in the
runner-local `~/.cache/caxri/bundle-baseline.json`, and every later run (PRs included) reports
deltas against it, degrading to `n/a` when no baseline exists. When releases begin, switch the
baseline source to the latest published release artifact.

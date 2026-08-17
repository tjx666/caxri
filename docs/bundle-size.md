# Bundle size baseline and budget gate

Caxri ships a packaged macOS app whose size is protected by a CI gate. This document records the
optimized baseline, the rules that keep it small, and how to analyze and re-budget when a change
legitimately needs more bytes.

## Baseline (2026-08, arm64 dir target)

| Artifact            | Size      | Dominant contents                                                  |
| ------------------- | --------- | ------------------------------------------------------------------ |
| `Caxri.app` (total) | ~276 MiB  | Electron 43 framework (~230 MiB, fixed cost)                       |
| `app.asar`          | ~38.6 MiB | `out/` bundles + native-module JS shims                            |
| `app.asar.unpacked` | ~5.5 MiB  | better-sqlite3 / node-pty / @parcel/watcher binaries               |
| `out/renderer`      | ~35.4 MiB | Monaco (~6.8 MiB JS + 15 MiB workers), fonts, vscode-icons (below) |
| `out/main`          | ~2.4 MiB  | Main + Host + Runtime with all pure-JS deps bundled                |
| `out/preload`       | ~8 KiB    | Sandboxed preload bundles                                          |

The renderer carries the full `@yutengjing/vscode-icons` SVG set (~4.5 MiB across 1553 files,
emitted as individual assets). This is a conscious budget increase, not drift: the Files inspector
can encounter any file or folder name in a user's project at runtime, so there is no meaningful
subset to tree-shake, and shipping the complete set is what makes icons match VS Code's
vscode-icons extension.

Pre-optimization the app was ~367 MiB on disk: 220 Electron locales (47 MiB), whole-package
`node_modules` copies in the asar (drizzle-orm 14 MiB, zod 5.7 MiB, xterm 5 MiB, archiver's
transitive tree ~7 MiB), multi-platform native prebuilds and sqlite source (~26 MiB), and a
1024px sidebar logo (0.5 MiB).

## Rules that keep the package small

1. **`dependencies` holds native modules only** (`@parcel/watcher`, `better-sqlite3`, `node-pty`).
   electron-builder copies the production dependency tree into the asar wholesale, so every
   pure-JS dependency lives in `devDependencies` and is bundled by electron-vite instead
   (tree-shaken, deduplicated). See `electron.vite.config.ts`.
2. **No bundler-invisible requires in Main/Host/Runtime.** A `createRequire`/dynamic `require`
   of a devDependency builds fine but crashes only in the packaged app. The budget gate loads
   `out/main/host.js` and `out/main/runtime.js` from the packaged asar with
   `ELECTRON_RUN_AS_NODE` to catch exactly this class of regression.
3. **Native packages ship binaries only.** `build.files` excludes non-darwin prebuilds and the
   C/C++ `deps`/`src` trees of better-sqlite3 and node-pty.
4. **Electron locales are pruned** to `electronLanguages` (en, en_GB, zh_CN, zh_TW).
5. **Renderer assets match their display size** (the sidebar logo is 128px, not the 1024px icon
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
probe, and asserts every artifact stays under its byte budget. Budgets are absolute ceilings with
headroom over this baseline — when the gate fails, first try to optimize the regression away;
only consciously raise the budget in `scripts/ci-bundle-budget.ts` and update this document in
the same PR.

### Job summary and baseline deltas

Every gate run appends a Markdown report to the GitHub Actions job summary: phase timings and a
component-level size breakdown (Electron runtime, asar, unpacked native modules, each `out/`
process, and inside the renderer the Monaco language workers and bundled fonts), each with its
budget and a percentage delta. Because the project has no public release yet, the comparison
baseline is the last green `main` build: a green `main` run stores its measurements in the
runner-local `~/.cache/caxri/bundle-baseline.json`, and every later run (PRs included) reports
deltas against it, degrading to `n/a` when no baseline exists. When releases begin, switch the
baseline source to the latest published release artifact.

---
kind: living
status: current
---

# Bundle size baseline and budget gate

Caxri ships a packaged macOS app whose size is protected by a CI gate. This document records the
optimized baseline, the rules that keep it small, and how to analyze and re-budget when a change
legitimately needs more bytes.

## Baseline (2026-09, arm64 dir target)

| Artifact                  | Size       | Dominant contents                                                         |
| ------------------------- | ---------- | ------------------------------------------------------------------------- |
| `Caxri.app` (total)       | ~497.5 MiB | Electron framework (44 when measured) + embedded Server                   |
| `Resources/server`        | ~137.6 MiB | Pinned runtime (~121 MiB), native dependencies, bundles, extensions       |
| `app.asar`                | ~116.8 MiB | Desktop Main, Preload, and Renderer bundles plus their source maps        |
| `out/renderer`            | ~113.2 MiB | Monaco (~6.8 MiB JS + 15 MiB workers), Mermaid, fonts, vscode-icons, maps |
| `out/main`                | ~4.06 MiB  | Electron Desktop Main only (measured 2026-10)                             |
| `out/preload`             | ~48 KiB    | Sandboxed preload bundles                                                 |
| `apps/server/dist/server` | ~137.6 MiB | Byte-identical source of the embedded Server artifact                     |

Roughly half of the JavaScript above is source maps, which ship in every build including the packaged
one. This is the single largest deliberate size decision in the project and it is not drift: Caxri is
built and debugged by coding agents, whose only view of a past failure is the artifact that produced
it. A minified packaged build cannot say which line threw, so every investigation of a production-only
failure would start with a rebuild and an attempt to reproduce: the expensive part of the loop. The
bytes buy that back, and the installer is dominated by the Electron runtime regardless. Turning maps
off is a product decision to make at the first public release, not a way to pass the budget gate.

Mermaid is ~23 MiB of the renderer with its source maps, added when the file preview shipped. It is
loaded through a dynamic `import('mermaid')`, so a document without a diagram never executes any of
it, but the chunks still occupy disk. Mermaid emits one lazy chunk per diagram type (almost all
under 500 KiB) plus two large layout backends: ELK (~6.5 MiB) and Cytoscape (~2.5 MiB), each loaded
only for the diagram kinds that need it. Aliasing those two to stubs would recover most of the
growth by silently breaking `architecture` diagrams and ELK layouts in a user's README, which is not
a trade this project wants to make invisibly; the renderer, asar, and app budgets were raised
together instead.

The PDF preview adds ~11 MiB with source maps (`out/renderer` measured 118.9 MiB before and
130.1 MiB after, 2026-10): pdf.js (~0.8 MiB), its viewer components (~0.3 MiB), its worker
(~1.7 MiB), and the data pdf.js asks for while parsing: 168 Adobe CMaps for CJK text in
non-embedded fonts, the Symbol and ZapfDingbats standard fonts, and the JBIG2 and JPEG 2000
WebAssembly decoders. Only files pdf.js actually requests are bundled: other standard fonts are
drawn with local system fonts, and the ICC decoder is never requested in this configuration. The
packaged Renderer is a `file://` page that cannot `fetch` application files, so each data file is
an inline module in its own lazy chunk (`features/preview/pdf-binary-data.ts`). None of it is in
the initial Renderer bundle (which grew by ~4 KB of routing code), and a PDF loads only the CMap or
decoder it actually uses. The renderer and asar budgets were raised to 140 MiB and 145 MiB.

The renderer carries the full `@yutengjing/vscode-icons` SVG set (~4.5 MiB across 1553 files,
emitted as individual assets). This is a conscious budget increase, not drift: the Files secondarySidebar
can encounter any file or folder name in a user's project at runtime, so there is no meaningful
subset to tree-shake, and shipping the complete set is what makes icons match VS Code's
vscode-icons extension.

Desktop Main grew from ~3.0 MiB to 4.06 MiB (4,261,667 B, 2026-10) across many features rather
than through one regression, so its budget was raised from 4 MiB to 5 MiB. About 67% of `out/main`
is source maps, and their `sourcesContent` alone is ~2 MB; the JavaScript (~1.4 MB) is not minified.
The largest bundled sources are `zod`, the `ws` transport, and `jsonc-parser`, plus the
`@caxri/protocol` build output. Minifying Main was considered and deferred: packaged Main stack
traces would then need source-map support (`process.setSourceMapsEnabled` or
`--enable-source-maps`) to stay readable. Dropping `sourcesContent` would contradict the
debuggable-without-rebuild goal above.

The Server runtime also carries the bundled ripgrep executable (~4.3 MiB) so project search uses a
known binary without relying on the host environment. The 150 MiB ceiling keeps roughly nine percent
headroom over the measured 137.6 MiB while the job-summary delta still exposes incremental growth.

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
`.cache/bundle-analysis/`. Use the JSON report to aggregate bytes per npm package or find modules
duplicated across chunks. Sonda attributes bytes through the source maps every build already emits.

## The CI budget gate

`scripts/ci-bundle-budget.ts` is one of the full platform gates in `scripts/ci-platform-gates.ts`.
`.github/workflows/ci.yml` runs those gates (in the `checks` job, or beside the E2E pools in the
`e2e` job for the optimized profile) only when `scripts/ci-execution-plan.ts` selects the `full`
checks scope: the nightly schedule, `workflow_dispatch`, and ready pull requests that touch a
full-validation path (global configuration such as `package.json`, tsconfig, Vite or Vitest config,
`patches/`, or a protected CI script). Ordinary ready source pull requests run the `affected` scope and skip this gate, so a
regression can land on `main` and first fail the next nightly run. The gate runs a
timed build, a timed `electron-builder --mac dir` packaging pass, the packaged module-resolution
artifact integrity and entry-point probe, and asserts every artifact stays under its byte budget. Budgets are absolute ceilings with
headroom over this baseline: when the gate fails, first try to optimize the regression away;
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

---
kind: living
status: current
---

# Bundle size baseline and budget gate

Caxri ships a packaged macOS app whose size is protected by a CI gate. This document records the
optimized baseline, the rules that keep it small, and how to analyze and re-budget when a change
legitimately needs more bytes.

## Baseline (2026-10, arm64 dir target)

The size gate counts **shipped bytes**: every file except Source Maps (`*.map`), including the files
inside `app.asar`. The maps still ship (see below), and the table reports them in their own column.

| Artifact                  | Shipped    | Source Maps | Dominant shipped contents                                             |
| ------------------------- | ---------- | ----------- | --------------------------------------------------------------------- |
| `Caxri.app` (total)       | ~415.2 MiB | ~101 MiB    | Electron framework + embedded Server                                  |
| `Resources/server`        | ~128.7 MiB | ~13.5 MiB   | Pinned runtime (~121 MiB), native dependencies, bundles, extensions   |
| `app.asar`                | ~41.0 MiB  | ~87.9 MiB   | Desktop Main, Preload, and Renderer bundles                           |
| `out/renderer`            | ~39.0 MiB  | ~86.9 MiB   | Monaco and its language workers, Mermaid, pdf.js, vscode-icons, fonts |
| `out/main`                | ~1.77 MiB  | ~3.4 MiB    | Electron Desktop Main only                                            |
| `out/preload`             | ~18 KiB    | ~45 KiB     | Sandboxed preload bundles                                             |
| `apps/server/dist/server` | ~128.7 MiB | ~13.5 MiB   | Byte-identical source of the embedded Server artifact                 |

Ordinary builds and the canonical `Caxri-<version>-arm64.dmg` include Source Maps because Caxri is
built and debugged by coding agents, whose only view of a past failure may be the artifact that
produced it. A packaged build without maps cannot say which line threw, so the maps avoid a
rebuild-and-reproduce cycle. A second `Caxri-<version>-arm64-nosourcemap.dmg` is rebuilt with maps
disabled for users who explicitly prefer the smaller artifact.

The gate excludes maps because the app never loads them: when they counted, they were more than half
of every Desktop figure, so growth in debugging metadata consumed the headroom meant for real code
and assets. Losing the maps is still a regression, so the gate also fails when `out/main`,
`out/renderer`, or `app.asar` stops carrying any.

The Renderer is minified without mangling (`electron.vite.config.ts`): whitespace removal and
compression took the shipped Renderer from ~56.2 MiB to ~39.0 MiB, while function and React
component names stay readable in Renderer stack traces and DevTools without a map lookup. Full
mangling would save only another ~5.6 MiB. Monaco and pdf.js workers are third-party code and use
the fully mangled default. Legal comments (`@license`, `/*!`) are kept. The terminal fonts ship as
WOFF2 (lossless; glyph sets identical to the upstream TTF), ~2 MiB smaller than TTF.

Mermaid is ~23 MiB of the renderer with its source maps, added when the file preview shipped. It is
loaded through a dynamic `import('mermaid')`, so a document without a diagram never executes any of
it, but the chunks still occupy disk. Mermaid emits one lazy chunk per diagram type (almost all
under 500 KiB) plus two large layout backends: ELK (~6.5 MiB) and Cytoscape (~2.5 MiB), each loaded
only for the diagram kinds that need it. Aliasing those two to stubs would recover most of the
growth by silently breaking `architecture` diagrams and ELK layouts in a user's README, which is not
a trade this project wants to make invisibly, so the size is accepted inside the budgets instead.

The PDF preview adds ~11 MiB with source maps (`out/renderer` measured 118.9 MiB before and
130.1 MiB after, 2026-10): pdf.js (~0.8 MiB), its viewer components (~0.3 MiB), its worker
(~1.7 MiB), and the data pdf.js asks for while parsing: 168 Adobe CMaps for CJK text in
non-embedded fonts, the Symbol and ZapfDingbats standard fonts, and the JBIG2 and JPEG 2000
WebAssembly decoders. Only files pdf.js actually requests are bundled: other standard fonts are
drawn with local system fonts, and the ICC decoder is never requested in this configuration. The
packaged Renderer is a `file://` page that cannot `fetch` application files, so each data file is
an inline module in its own lazy chunk (`features/preview/pdf-binary-data.ts`). None of it is in
the initial Renderer bundle (which grew by ~4 KB of routing code), and a PDF loads only the CMap or
decoder it actually uses.

The renderer carries the full `@yutengjing/vscode-icons` SVG set (~4.5 MiB across 1553 files,
emitted as individual assets). This is a conscious budget increase, not drift: the Files secondarySidebar
can encounter any file or folder name in a user's project at runtime, so there is no meaningful
subset to tree-shake, and shipping the complete set is what makes icons match VS Code's
vscode-icons extension.

Desktop Main ships ~1.77 MiB of unminified JavaScript; the largest bundled sources are `zod`, the
`ws` transport, and `jsonc-parser`, plus the `@caxri/protocol` build output. Minifying Main was
considered and deferred: packaged Main stack traces would then need source-map support
(`process.setSourceMapsEnabled` or `--enable-source-maps`) to stay readable, for well under 1 MiB of
savings. Dropping `sourcesContent` from any map would contradict the debuggable-without-rebuild goal
above.

The Server runtime also carries the bundled ripgrep executable (~4.3 MiB) so project search uses a
known binary without relying on the host environment. The 140 MiB ceiling keeps roughly nine percent
headroom over the measured 128.7 MiB shipped bytes while the job-summary delta still exposes
incremental growth.

Pre-optimization the app was ~367 MiB on disk: 220 Electron locales (47 MiB), whole-package
`node_modules` copies in the asar (drizzle-orm 14 MiB, zod 5.7 MiB, xterm 5 MiB, archiver's
transitive tree ~7 MiB), multi-platform native prebuilds and sqlite source (~26 MiB), and a
1024px primarySidebar logo (0.5 MiB).

## Rules that keep the package small

1. **The root has no production dependencies.** Desktop pure JavaScript is bundled into `app.asar`;
   Server dependencies are assembled only inside `apps/server/dist/server`.
2. **The standalone Server owns its runtime.** Desktop and platform deployments copy the same
   manifest-bound directory, including the pinned runtime, native dependencies, and extensions.
   Database migrations are compiled into the Server Core bundle. The budget gate verifies both copies and loads all three Server entry points using
   that runtime.
3. **Native packages ship selected runtime inputs only.** The artifact builder excludes unrelated
   platform prebuilds, C/C++ source trees, documentation, type declarations, source maps, and tests
   while preserving license files and executable helper modes.
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
checks scope: pushes to `main`, `workflow_dispatch`, and ready pull requests that touch a
full-validation path (global configuration such as `package.json`, tsconfig, Vite or Vitest config,
`patches/`, or a protected CI script). Ordinary ready source pull requests run the `affected` scope and skip this gate, so a
regression can first fail after the merge on `main`. The gate runs a
timed build, a timed `electron-builder --mac dir` packaging pass, the packaged module-resolution
artifact integrity and entry-point probe, asserts every artifact's shipped bytes (Source Maps
excluded, measured per file inside `app.asar` from its header) stay under its byte budget, and
fails when a debuggable artifact no longer carries any Source Map. Budgets are absolute ceilings with
headroom over this baseline: when the gate fails, first try to optimize the regression away;
only consciously raise the budget in `scripts/ci-bundle-budget.ts` and update this document in
the same PR.

### Job summary and baseline deltas

Every gate run appends a Markdown report to the GitHub Actions job summary: phase timings and a
component-level size breakdown (Electron runtime, asar, standalone Server runtime/native/bundles,
each Desktop `out/` surface, and the Renderer Monaco workers and fonts), each with its shipped
size, its Source Map size, its budget, and a percentage delta of the shipped size. Repeated local runs on one machine can compare against its
`~/.cache/caxri/bundle-baseline.json`. Disposable hosted runners do not inherit that user cache, so
their delta normally reports `n/a`; the absolute byte and time budgets remain the portable gate.
When releases begin, switch the comparison source to the latest published release artifact.

# Stack baseline

- Researched: 2026-08-04 (Asia/Shanghai)
- Target: macOS 26 on arm64, Electron desktop application
- Version authority: allowed ranges in workspace manifests and catalogs; resolved versions in `pnpm-lock.yaml`

Only official project documentation, official repositories, and the npm registry were used. Package numbers are intentionally not duplicated here because `package.json` is the version source of truth.

Prefer current stable releases and mature third-party libraries. Caxri adopts and upgrades
dependencies aggressively; do not hand-roll commodity functionality or retain stale versions merely
to minimize dependency churn. Confirm architecture fit, browser/native boundaries, bundle/runtime
cost, and supply-chain policy before adoption.

Default ordinary dependency declarations to caret (`^`) ranges, including shared catalog entries.
The lockfile keeps local and CI installations reproducible; a caret permits compatible updates
when dependency resolution is intentionally refreshed, rather than updating every frozen install.

Keep these compatibility exceptions:

- `@xterm/*`: exact beta versions from one verified upstream commit, with matching core peers.
- `electron-vite`: exact accepted beta until the stable Vite 8 integration is adopted.
- `electron`: exact prerelease while Caxri tracks the 45 alpha line, adopted for Chromium 155.
  A caret is unsafe on a prerelease: `^45.0.0-alpha.10` would resolve forward to any later 45 alpha,
  so an unrelated install could silently change the Chromium and Node under the Renderer and Main.
  The matching `minimumReleaseAgeExclude` entry exists because the alpha line publishes faster than
  the release-age floor. Drop the pin back to `^` once Electron 45 is stable.
  The native add-ons are not part of this risk: `better-sqlite3`, `node-pty`, and `@parcel/watcher`
  load in the Server artifact's own bundled Node runtime (`runtime/bin/node`), never in Main or the
  Renderer, so they follow that runtime's ABI rather than Electron's.
- `@base-ui/react`: exact 1.7.0. Version 1.8.0 triggers a `PopoverStore` / `syncTriggerCount`
  update loop when opening the multi-trigger Editor breadcrumb picker (React error 185).
  `e2e/editor-breadcrumbs.e2e.ts` reproduces it locally and in
  [CI run 34299568185](https://github.com/tjx666/caxri/actions/runs/34299568185).
  Re-checked 2026-09-21 against 1.8.0, still the newest release: the spec fails the same way and the
  whole Renderer falls through to the "Something went wrong" boundary, so the pin stays.
  Re-evaluate it only after that regression passes on a newer release.
- `typescript` / `@typescript/native` npm aliases: exact TypeScript 6 API and TypeScript 7 CLI pair.
- Expo-managed mobile runtime dependencies and React types: SDK-recommended exact or tilde ranges.
  This includes React, React Native, Metro, FlashList, Reanimated, Worklets, and native addons.
- Corrective `overrides`: exact known-good versions, with the compatibility reason documented next
  to the override. Revisit them when the affected upstream dependency changes.

`patches/sonner.patch` keeps both blur and unmount focus restoration from stealing focus while a
modal is open, while still clearing Sonner's prior-focus bookkeeping. `ToastOutlet` supplies a live
`shouldRestoreFocus` callback from the shared modal registry; Base UI does not expose `aria-modal`.
The patch covers ESM and CommonJS;
retain the patch until the [upstream restoration paths](https://github.com/emilkowalski/sonner/blob/main/src/index.tsx)
respect modal ownership. Recheck the GPU notification/dialog and ordinary notification expiry E2E
when updating Sonner.

Tool runtime pins in `mise.toml` and `.bun-version`, workspace references, package versions, and
extension engine contracts are not ordinary third-party dependency ranges.

`ni` v29+ automatically enters catalog mode in this workspace. For a dependency owned by only one
workspace, use `NI_CATALOG=false ni '<package>@^<version>' --filter <workspace>` so it remains a
workspace dependency instead of creating a shared catalog entry. Use `-E` only for an exception
above or another explicitly documented compatibility constraint.

Never change the `typescript` / `@typescript/native` dependency aliases or run
`npm i typescript@latest`. The repository pins TypeScript 6 for typescript-eslint while compiling
with TypeScript 7; see [electron-toolchain.md](electron-toolchain.md).

| Package / area       | Official source                                                                                                 | Compatibility and selection notes                                                                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron             | <https://www.electronjs.org/docs/latest/>                                                                       | `utilityProcess.fork` is available after app ready. Renderers use context isolation, sandboxing, and no Node integration. No native module loads in Main or the Renderer.                                                                                                                                                                 |
| React                | <https://react.dev/versions>                                                                                    | Latest stable React 19 line; no experimental channel.                                                                                                                                                                                                                                                                                     |
| React Compiler       | <https://react.dev/learn/react-compiler/installation>                                                           | Stable compiler using the official Vite 8 integration: `@rolldown/plugin-babel` runs `reactCompilerPreset()` for Renderer inputs, and `eslint-plugin-react-hooks` uses `recommended-latest` for compiler-aware diagnostics.                                                                                                               |
| Vite                 | <https://vite.dev/releases> and <https://vite.dev/guide/>                                                       | Vite 8 is current. Node 22.12+ satisfies its engine range; the React plugin and Electron integration are selected from releases that explicitly declare Vite 8 support.                                                                                                                                                                   |
| electron-vite        | <https://electron-vite.org/guide/>                                                                              | The 6.0 beta is the first published line declaring Vite 8 support. Its beta risk is accepted and covered by build, Electron E2E, native probes, and package validation; see [electron-toolchain.md](electron-toolchain.md).                                                                                                               |
| electron-builder     | <https://www.electron.build/docs/>                                                                              | Packages the Desktop app and embeds the prebuilt Server artifact under `Contents/Resources/server`; there is no production dependency graph to flatten into ASAR.                                                                                                                                                                         |
| shadcn/ui            | <https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default>                                                  | Base UI is the recommended default for new projects. Caxri pins `base-nova` in `components.json`, uses `@base-ui/react` primitives, and keeps locally owned component source.                                                                                                                                                             |
| Lucide               | <https://lucide.dev/guide/packages/lucide-react>                                                                | Single React icon family; icons remain tree-shakeable components.                                                                                                                                                                                                                                                                         |
| Fuse.js              | <https://www.fusejs.io/>                                                                                        | Current stable, zero-dependency Renderer search engine. Caxri-owned semantic tiers keep identity fields ahead of descriptions; Fuse supplies weighted typo-tolerant and multi-token ranking within those tiers.                                                                                                                           |
| Tailwind CSS         | <https://tailwindcss.com/docs/theme>                                                                            | v4 via `@tailwindcss/vite`. The default palette is unregistered; only semantic tokens bridged from the runtime theme variables compile (DESIGN.md principle 5), so imported themes restyle utilities live without a rebuild.                                                                                                              |
| xterm.js             | <https://github.com/xtermjs/xterm.js>                                                                           | Current package namespace is `@xterm/*`. Caxri pins one exact beta commit across core/headless and compatible addons so WebGL fixes cannot drift independently. Renderer and Runtime headless screens both activate Unicode 11; OSC 52 uses a Caxri-owned, write-only, bounded provider; snapshot serialization remains bounded by Caxri. |
| Parcel Watcher       | <https://github.com/parcel-bundler/watcher>                                                                     | Native recursive filesystem backends avoid per-path descriptors in large Projects and match the watcher foundation used by VS Code. It watches both active Project roots and the bounded global configuration directory.                                                                                                                  |
| vscode-ripgrep       | <https://github.com/microsoft/vscode-ripgrep>                                                                   | The Server owns the `@vscode/ripgrep-universal` dependency and stages only the build platform's executable. Project Search invokes the artifact binary by absolute path with `--no-config` for bounded candidate enumeration; a terminable Worker retains Caxri's path, hard-link, content-read, and JavaScript regex contracts.          |
| node-pty             | <https://github.com/microsoft/node-pty>                                                                         | Supports macOS. It is a Server dependency loaded only by the Server artifact's bundled Node runtime. PTY launches use executable + argv rather than shell strings.                                                                                                                                                                        |
| Monaco Editor        | <https://github.com/microsoft/monaco-editor>                                                                    | Use the ESM build and Vite worker URLs; the legacy AMD build is deprecated.                                                                                                                                                                                                                                                               |
| better-sqlite3       | <https://github.com/WiseLibs/better-sqlite3>                                                                    | Selected for transactions, WAL, and predictable synchronous calls isolated in the Runtime. It loads through the Server artifact runtime; the native spike verifies the real ABI.                                                                                                                                                          |
| Drizzle ORM          | <https://orm.drizzle.team/docs/get-started-sqlite>                                                              | Declarative schema (`apps/server/src/domains/db/schema.ts`) over the better-sqlite3 driver. drizzle-kit generates checked-in migration SQL that the Runtime bundles via `?raw`; the raw handle stays for pragmas and transactions.                                                                                                        |
| Vitest               | <https://vitest.dev/guide/>                                                                                     | Stable unit/integration runner compatible with the selected Vite and current Node.                                                                                                                                                                                                                                                        |
| TypeScript           | <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0> | TypeScript 7 is the current compiler. The official side-by-side layout exposes its native `tsc` through `@typescript/native`, while the `typescript` package name resolves to the TypeScript 6 compatibility API required by `typescript-eslint`.                                                                                         |
| Playwright Electron  | <https://playwright.dev/docs/api/class-electron>                                                                | Electron automation remains marked experimental but is the maintained E2E API. Native dialogs are stubbed through main-process evaluation in deterministic tests.                                                                                                                                                                         |
| Dracula              | <https://github.com/dracula/dracula-theme>                                                                      | Official OSS palette and MIT attribution are vendored. UI, terminal, and editor map from one semantic source.                                                                                                                                                                                                                             |
| VS Code theme import | <https://code.visualstudio.com/api/references/theme-color>                                                      | Import only supported workbench/editor and token colors from a single JSON file; do not install extensions.                                                                                                                                                                                                                               |
| iTerm2 theme import  | <https://iterm2.com/documentation-preferences-profiles-colors.html>                                             | `.itermcolors` is an Apple plist containing terminal color presets. Import terminal colors and inherit remaining semantic tokens.                                                                                                                                                                                                         |
| Warp theme import    | <https://docs.warp.dev/terminal/appearance/custom-themes>                                                       | Parse current YAML fields (`accent`, foreground/background, details, and 16 terminal colors). Ignore backgrounds/images and warn for unsupported fields.                                                                                                                                                                                  |
| Claude Code CLI      | <https://docs.anthropic.com/en/docs/claude-code/cli-usage>                                                      | Local CLI help confirms interactive launch plus `--resume`/`--continue`. Discovery and state reads are capability-based and read-only.                                                                                                                                                                                                    |
| Codex CLI            | Local `codex --help` plus <https://developers.openai.com/codex/cli/reference>                                   | Local CLI help is the launch-time authority; interactive launch is `codex` and resume is a structured subcommand. No internal storage write is permitted.                                                                                                                                                                                 |

## Accepted primitive exception: cmdk command list

- Decision: keep `cmdk` only as the Command Palette's inner filtering, grouping, and keyboard-selection engine. The modal, backdrop, focus trap, dismissal, and modal-open registration remain the shared Base UI `Dialog`; no other Renderer surface may import `cmdk` or Radix primitives.
- Bundle evidence (2026-08-08 production Renderer build with source maps): the main Renderer entry was 1,526,761 B minified and 350,951 B gzip. Generated ranges attributed to `cmdk` were 15,033 B and its Radix-only transitive sources were 50,052 B, totaling 65,085 B (4.26%). Those attributed fragments gzip independently to about 15,455 B (4.40% of the entry gzip size; an attribution estimate, not a standalone chunk).
- Rationale: this bounded local-desktop cost is acceptable for a mature accessible command-list implementation. Rebuilding filtering and keyboard selection on another primitive would add interaction risk without removing the Base UI modal, which already owns focus and dismiss semantics.
- Guardrail: re-evaluate this exception if another workbench surface needs cmdk/Radix, if focus or dismissal diverges from the shared Dialog, or if bundle analysis shows material growth. Palette E2E must continue covering autofocus, Escape dismissal, filtering/groups, shortcut hints, and the intentional absence of a close button.

## Local compatibility target

The baseline machine provides Node 24, Bun 1.3, Xcode Command Line Tools, current Claude Code, and current Codex. Native probes must execute through the Server artifact's `runtime/bin/node`, because host Node success does not prove artifact-runtime ABI compatibility.

## Recovery and notification dependency patches

- `patches/node-pty@1.1.0.patch` adds write-completion and input-quiescence barriers to the Unix
  PTY writer for exact managed Agent submission. Keep its runtime JS, source TS, and typings in
  sync; the patch also restores the prebuilt spawn helper's executable bit after extraction.
  Recheck the real PTY shell handoff and close-during-write regressions before removing it.
- `patches/xterm-addon-serialize.patch` clips stale alternate-buffer cells to the visible grid and
  fixes [full-row cursor restoration](https://github.com/xtermjs/xterm.js/issues/6165). Both shipped
  module formats and upstream source carry the same correction. Remove it only after the owning
  `screen.test.ts` round-trip cases pass against the replacement package.
- `patches/sonner.patch` preserves pause accounting when an options menu changes a notification
  from finite duration to Infinity and back. Upstream's
  [duration reset](https://github.com/emilkowalski/sonner/pull/533) does not reset that timer baseline.
  Keep the long-open menu E2E when upgrading or removing this patch.

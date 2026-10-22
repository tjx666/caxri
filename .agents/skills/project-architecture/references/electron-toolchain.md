# ADR 0001: Electron build and packaging toolchain

- Status: accepted
- Date: 2026-08-03

## Decision

Use `electron-vite` for Desktop Main, Preload, and Renderer builds; use Vite directly for the standalone Server bundles; and use `electron-builder` for macOS packaging.

Every local and CI package stages beneath `release.noindex/`. The output root must carry the `.noindex` suffix before
Electron Builder creates a runnable `.app`; modern macOS can index an ordinary staging directory before a later marker
or cleanup runs, causing worktree artifacts to appear as duplicate installed Caxri applications. Production,
E2E-specific, bundle-budget, local-DMG, and release-workflow paths all share this output boundary.

`ELECTRON_RENDERER_URL` is an unpackaged electron-vite development input only. Packaged Workbench
and Process Explorer windows always resolve their renderer entry files from the application bundle,
so an inherited development URL cannot redirect either privileged window.

The root remains the private pnpm workspace owner and the only lockfile owner. `apps/desktop`,
`apps/server`, and `apps/cli` own independently runnable product entrypoints; the root owns no product
`src/` tree. `packages/protocol` owns browser-safe schemas, types, and wire errors, while `apps/cli`
may depend on public packages but never on Electron, Server internals, or native modules.
Day-to-day commands continue through `ni` and `bun run`. `mise.toml` pins Node and pnpm for local
development, CI provisions those versions explicitly, and the root intentionally omits
`packageManager` and `devEngines.packageManager` so package-manager selection does not depend on
Corepack-compatible manifest metadata. The standalone pnpm tool precedes Node in `mise.toml` because
Node installations may contain a Corepack pnpm shim whose last-known-good version differs from the
repository pin.

Electron 42 and later expose `install-electron` instead of a package lifecycle script. Dependency
installation therefore does not guarantee that `path.txt` and the Electron distribution exist. The
root `electron:install` script is the shared explicit download entrypoint for local development and
CI; the worktree launcher additionally verifies the versioned binary artifacts before starting.

Workspace builds run before Desktop development startup and the production Desktop build. The root
manifest intentionally has no Electron `main`, so development launches electron-vite with the explicit
`out/main/index.js` entry. Server development has its own Vite watcher, which refreshes the standalone
directory artifact after bundle changes; Desktop waits for that watcher's first verified artifact and
fails clearly after five minutes if readiness is never published. `CAXRI_SERVER_WATCH_READY_TIMEOUT_MS`
overrides that development-only timeout for diagnostics. electron-builder embeds that exact artifact under
`Contents/Resources/server` and has no production dependency graph to flatten into ASAR. The standalone
CLI enters the app only through its explicit packaging resource.

Bundled extensions are independent `extensions/*` workspace packages with package-local TypeScript
programs and a development-only `caxri: workspace:*` dependency. Their ESM bundles keep `caxri`
external so the Extension Host remains the only runtime API provider. The Server artifact contains
only product extensions; `package:e2e` rebuilds a separately manifested Server artifact with the
`testOnly` Fixture and restores the production artifact afterward.

The Electron `RunAsNode` fuse remains enabled only for the packaged CLI launcher. Server supervision
uses `server/runtime/bin/node` from the standalone artifact; its Core, Runtime, Extension Host,
lifecycle-hook bridge, and native dependencies never execute through Electron. Packaging validation
hashes both Server copies, loads all Server process entrypoints using the pinned artifact runtime, and
executes a real Project Search through the staged `server/runtime/bin/rg` and search Worker.
Every standalone and SSH Host Server artifact also integrity-binds the repository's third-party notice,
all repository license files, and the LICENSE from the installation or official archive that supplies
its exact Node runtime.

The Desktop build consumes `@caxri/client` and `@caxri/protocol` through public package exports while
leaving workspace links out of the packaged application. Main discovers and supervises the embedded
Server artifact without importing `apps/server` source.

Repository scripts run through Bun and resolve private workspace package exports directly to their
TypeScript sources through the `bun` export condition. This keeps fresh worktrees runnable without ignored
`dist` directories and prevents contributor checks from loading stale build output. The public `caxri`
Extension API remains `dist`-only because its published package does not include `src`; repository Node and
Extension typechecks map that specifier to the current source through their local `paths` settings. Extension
bundles keep the specifier external for the Extension Host, so this mapping does not change emitted or
packaged runtime imports. See [Bun's module resolution documentation](https://bun.sh/docs/runtime/module-resolution#package-resolution)
and [TypeScript's paths documentation](https://www.typescriptlang.org/tsconfig/paths.html).

Packaged Main processes treat `ELECTRON_RENDERER_URL` as a development-only override: application
logs always resolve beneath Electron `userData`, never relative to the packaged application bundle.

The CLI build also emits one self-contained CommonJS artifact that imports only Node built-ins. The
standalone distribution and `Contents/Resources/cli/caxri.cjs` are copied from that same file, while
`Contents/Resources/bin/caxri` resolves symlinks and launches it through the packaged Caxri binary
with `ELECTRON_RUN_AS_NODE=1`. Packaging must preserve executable bits, explicitly keep the
`RunAsNode` fuse enabled, and prove byte identity between the standalone and embedded bundle.

Before a public release, an incompatible live Host fails startup instead of entering a protocol
migration flow. Main shows the repository-owned uninstall/reset command and quits; that explicit,
dry-run-first tool owns graceful Host termination and recoverable local-state removal. A dead Host's
stale discovery record remains replaceable through the profile lock. Database schema migrations are
independent and continue to preserve the active development database until an explicit clean-install
cutoff.

The Renderer build enables stable React Compiler through the official Vite 8 `@rolldown/plugin-babel` integration and `reactCompilerPreset()`. The Babel stage belongs only to the Renderer pipeline; Main, Host, Preload, and Runtime remain on their existing Node-oriented transforms.

The compiler skips any component or hook it cannot lower (`try` without `catch`, `try`/`finally`, `??=`, a `throw` inside `try`, an ESLint suppression of a React rule) without a build error, so the skipped code silently loses memoization. `scripts/__tests__/react-compiler-coverage.test.ts` compiles every Renderer source with `scripts/react-compiler-options.ts`, the options the build also reads, and runs in the `guards` job. It fails on a bailout missing from `scripts/react-compiler-known-bailouts.ts` and on a ledger entry that now compiles, so the ledger only shrinks. Rewrite new code so it compiles, for example settle a promise with `.then(cleanup, cleanup)` instead of `try`/`finally`; do not add a ledger entry.

Desktop Main, Preload, Renderer, and the embedded macOS Server share the strict
`CAXRI_SOURCE_MAPS=include|omit` build flavor. An absent variable defaults to `include`; any other
explicit value fails the build. Ordinary builds and the canonical macOS DMG include Source Maps.
The release pipeline rebuilds every product bundle with `omit` for a second DMG rather than deleting
maps after packaging, because the Server integrity manifest must be generated from the exact files it
ships. The two app directories and DMGs use isolated output roots under `release.noindex/`.

Electron Forge's official Vite plugin remains explicitly experimental and provides no API-stability guarantee. `electron-vite` documents Electron `utilityProcess`, externalizes production/native dependencies, and fits the required process model.

Vite 8 requires `electron-vite@6`, the first stable line that declares Vite 8 support. electron-vite leaves `build.minify` off by default; Caxri turns it on for the Renderer only, without mangling (see [docs/bundle-size.md](../../../../docs/bundle-size.md)).

TypeScript 7 is the registry latest but does not ship a JavaScript API. Caxri follows the official side-by-side layout: `@typescript/native` supplies the TypeScript 7 `tsc` binary, while the `typescript` package name aliases `@typescript/typescript6` so typed ESLint rules continue to receive the supported TypeScript 6 API. Re-evaluate the alias after TypeScript 7.1 and native typed-lint support ship.

`apps/mobile` is the one exception. Expo tooling expects the `typescript` JavaScript API from the app itself (the Expo CLI TypeScript prerequisite, and `@expo/require-utils`, which looks for `transpileModule` to load `app.config.ts` and rejects TypeScript 7), so that workspace declares the plain TypeScript 6 package. Its `tsc` bin shadows the root TypeScript 7 CLI, so the mobile `typecheck` script runs the TypeScript 6 compiler; [stack-baseline.md](stack-baseline.md) records the exception and the toolchain contract test pins its major.

`@parcel/watcher`, `better-sqlite3`, and `node-pty` are Server application dependencies. The artifact
builder copies only their selected runtime inputs and compatible prebuilds, preserves executable helper
modes, and records every byte in the artifact manifest. The native spike loads all three with the
artifact runtime, requires delivery of a real file-write watcher event, opens SQLite, and spawns a PTY.

`@vscode/ripgrep-universal` is also owned only by the Server workspace, but it is a build-time binary
source rather than a runtime package import. The artifact builder selects the current platform and
architecture explicitly, copies the executable to `runtime/bin/rg`, preserves mode `0755`, stages its
upstream and wrapper licenses, and includes those files in artifact integrity receipts. Runtime code never searches `PATH` or
imports the npm package; Server Core injects the absolute artifact path into the Files domain. macOS
release validation must treat `rg` as a nested executable for signing and notarization.

The GitHub Release path runs on a disposable GitHub-hosted Apple Silicon runner and
produces unsigned Source Map and no-map arm64 DMGs. Only a pushed `main` commit whose subject exactly matches
`release: v<package-version>` may trigger it; normal commits remain CI-only. The release job must
validate the package version and unused tag, run all release gates, launch the canonical Source Map app through
the startup benchmark, verify both DMGs, and upload one SHA-256 checksum per asset. Signing and notarization are a
separate public-distribution decision and must not be inferred from the presence of this workflow.

Exact trusted release commits run hosted checks before downstream packaging uses a non-persisted,
short-lived `contents: write` token. Release readiness is established by the complete hosted
unit/integration suite, build and native checks, package validation, targeted Electron smoke, and
the no-publish Release rehearsal. A full E2E receipt is not part of that gate; `hosted-full` remains
a future manual route that requires fresh maintainer authorization for every dispatch. Its fixed
Renderer performance scenario still emits a receipt, while the retired cross-run baseline remains
unarmed until enough same-image GitHub-hosted samples support recalibration.

The repository-local `setup-caxri-job` composite action owns common toolchain setup. CI reads exact
Node and pnpm versions from `mise.toml`, installs them through `actions/setup-node` and `pnpm/setup`,
and pins Bun through `.bun-version`, without changing the user's interactive installations. Hosted
jobs install Bun explicitly and keep pnpm, Electron, Playwright, ESLint, and Prettier state below
`RUNNER_TEMP`; they never require a prewarmed `RUNNER_TOOL_CACHE/caxri/bun` or persistent
runner-owned tool and cache locations.
Jobs that exercise capture or media-analysis contracts install FFmpeg on disposable hosted runners
and verify `ffmpeg`, `ffprobe`, and the `libx264` encoder on every runner route before tests start.
pnpm owns workspace dependency resolution, installation, linking, and the lockfile; Bun is the fast
script, TypeScript, and repository CLI runner. Dependency trees remain job-local and are rebuilt
from `pnpm-lock.yaml` for every source job.

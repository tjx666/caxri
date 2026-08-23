# ADR 0001: Electron build and packaging toolchain

- Status: accepted
- Date: 2026-08-03

## Decision

Use `electron-vite` for separate Main, Headless Host, Extension Host, Preload, Runtime, and Renderer Vite builds, and `electron-builder` for macOS packaging and native dependency rebuilds.

Every local and CI package stages beneath `release.noindex/`. The output root must carry the `.noindex` suffix before
Electron Builder creates a runnable `.app`; modern macOS can index an ordinary staging directory before a later marker
or cleanup runs, causing worktree artifacts to appear as duplicate installed Caxri applications. Production,
E2E-specific, bundle-budget, local-DMG, release-workflow, and self-hosted cleanup paths all share this output boundary.

`ELECTRON_RENDERER_URL` is an unpackaged electron-vite development input only. Packaged Workbench
and Process Explorer windows always resolve their renderer entry files from the application bundle,
so an inherited development URL cannot redirect either privileged window.

The root remains the private pnpm workspace owner and the only lockfile owner. `packages/protocol`
owns browser-safe schemas, types, and wire errors, while `packages/cli` is a Node-only client that
may depend on the protocol but never on Electron, the Runtime, or native modules. Existing Desktop
source stays under `src/`; introducing workspaces is not an application-directory migration.
Day-to-day commands continue through `ni` and `bun run`. `mise.toml` pins Node and pnpm for local
development, CI provisions those versions explicitly, and the root intentionally omits
`packageManager` and `devEngines.packageManager` so package-manager selection does not depend on
Corepack-compatible manifest metadata.

Workspace builds run before Desktop development startup and the production Desktop build. This
keeps ignored `dist` artifacts synchronized before electron-vite resolves workspace runtime exports.
electron-builder excludes the development workspace links from its broad `node_modules` input; a
workspace artifact enters the app only through an explicit Desktop build or packaging entry. This
prevents workspace-link traversal from accidentally shipping the standalone CLI. Local installs keep
pnpm's isolated layout; electron-builder flattens the packaged dependency graph into its ASAR-facing
`node_modules` layout so the existing ASAR unpack rules keep matching native modules.

Bundled extensions are independent `extensions/*` workspace packages with package-local TypeScript
programs and a development-only `caxri: workspace:*` dependency. Their ESM bundles keep `caxri`
external so the Extension Host remains the only runtime API provider. Production packaging copies
only product extensions such as Status; `testOnly` Fixture is added only by the explicit
`package:e2e` profile into a separate output directory. Runtime `testOnly` filtering is defense in
depth, not the release-artifact boundary.

The Electron `RunAsNode` fuse remains enabled deliberately. Both the provider lifecycle-hook bridge
and the profile-scoped Headless Host execute the packaged Caxri binary with
`ELECTRON_RUN_AS_NODE=1`; the Host then separately supervises `out/main/runtime.js` and
`out/main/extension-host.js` as advanced-serialization Node IPC children so they retain Electron ABI
parity without launching Chromium. Packaging validation must keep proving that `host.js`,
`extension-host.js`, and `runtime.js` load from `app.asar` while native modules load
from `app.asar.unpacked`. Disabling this fuse requires replacing both production launch paths first.

The Desktop build explicitly bundles `@caxri/cli` and `@caxri/protocol` into Main while leaving the
standalone workspace links out of the packaged application. This gives Main the authenticated Host
client without making packaged startup depend on a pnpm workspace symlink.

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

Electron Forge's official Vite plugin remains explicitly experimental and provides no API-stability guarantee. `electron-vite` documents Electron `utilityProcess`, externalizes production/native dependencies, and fits the required process model.

Vite 8 requires `electron-vite@6`; while that integration is still beta, it explicitly declares Vite 8 support. Caxri accepts the beta integration behind full build, Electron E2E, native-probe, startup-performance, and packaged-application validation rather than forcing an invalid Vite peer combination.

TypeScript 7 is the registry latest but does not ship a JavaScript API. Caxri follows the official side-by-side layout: `@typescript/native` supplies the TypeScript 7 `tsc` binary, while the `typescript` package name aliases `@typescript/typescript6` so typed ESLint rules continue to receive the supported TypeScript 6 API. Re-evaluate the alias after TypeScript 7.1 and native typed-lint support ship.

`@parcel/watcher`, `better-sqlite3`, and `node-pty` remain production dependencies and are unpacked
from ASAR. `@parcel/watcher` loads its platform-specific Node-API package directly; rebuilding its
wrapper package compiles an unused duplicate binary, so development and CI rebuild only
`better-sqlite3` and `node-pty`. The Electron native spike must load all three modules after that
selective rebuild. Packaging verification must execute a probe from the packaged Runtime before
release.

The private GitHub Release path runs on the repository-level Apple Silicon self-hosted runner and
publishes an unsigned arm64 DMG for personal use. Only a pushed `main` commit whose subject exactly matches
`release: v<package-version>` may trigger it; normal commits remain CI-only. The release job must
validate the package version and unused tag, run all release gates, launch the packaged app through
the startup benchmark, verify the DMG, and upload a SHA-256 checksum. Signing and notarization are a
separate public-distribution decision and must not be inferred from the presence of this workflow.

Every GitHub Actions job runs on the repository-level Apple Silicon `m2-24` self-hosted runner.
Retry policy, platform checks, and the final gate select `caxri-ci`; Electron E2E selects
`caxri-e2e`; downstream packaging selects `caxri-release`. There is no GitHub-hosted fallback.
Workflow event metadata must reject untrusted source execution before checkout: only owner-authored,
owner-triggered same-repository PRs, trusted `main` pushes, and owner dispatches may execute
repository code. Untrusted PRs run only the fixed no-checkout final gate and fail closed.

Every source-executing job uses owner-scoped process, desktop-lease, profile, temporary-directory,
and workspace cleanup. Exact trusted release commits route both their full E2E and downstream
packaging through the same machine with a non-persisted, short-lived `contents: write` token.
Reusing an existing macOS user is an accepted trust decision and must never be described as
isolation from malicious workflow code; see `docs/self-hosted-runner.md` for operation and incident
recovery.

The repository-local `setup-caxri-job` composite action owns common toolchain setup. CI provisions
exact Node 24 through `actions/setup-node`, installs pnpm 12 through `pnpm/setup` only on a runner
tool-cache miss, and pins Bun through `.bun-version`, without changing the user's interactive
installations. pnpm owns workspace dependency resolution, installation, linking, and the lockfile;
Bun is the fast script, TypeScript, and repository CLI runner. Node, pnpm, and Bun use versioned
runner-owned tool locations; the pnpm store, Electron, ESLint, and Prettier reuse runner-local caches
without `actions/cache`. Dependency trees remain job-local and are rebuilt from `pnpm-lock.yaml` for
every source job.

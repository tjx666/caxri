# ADR 0001: Electron build and packaging toolchain

- Status: accepted
- Date: 2026-08-03

## Decision

Use `electron-vite` for separate Main, Preload, Runtime, and Renderer Vite builds, and `electron-builder` for macOS packaging and native dependency rebuilds.

The root remains the private npm workspace owner and the only lockfile owner. `packages/protocol`
owns browser-safe schemas, types, and wire errors, while `packages/cli` is a Node-only client that
may depend on the protocol but never on Electron, the Runtime, or native modules. Existing Desktop
source stays under `src/`; introducing workspaces is not an application-directory migration.
Day-to-day commands continue through `ni` and `bun run`, and `packageManager` remains pinned to npm
because electron-builder uses npm's dependency layout and `install-app-deps` behavior.

Workspace builds run before the Desktop build. electron-builder excludes the development workspace
links from its broad `node_modules` input; a workspace artifact enters the app only through an
explicit Desktop build or packaging entry. This prevents npm symlink traversal from accidentally
shipping the standalone CLI while preserving the hoisted native dependency locations and ASAR
unpack rules.

The Renderer build enables stable React Compiler through the official Vite 8 `@rolldown/plugin-babel` integration and `reactCompilerPreset()`. The Babel stage belongs only to the Renderer pipeline; Main, Preload, and Runtime remain on their existing Node-oriented transforms.

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

The repository-local `setup-caxri-job` composite action owns common toolchain setup. CI selects
Node 22, pins Bun through `.bun-version`, and pins npm through `package.json#packageManager` without
changing the user's interactive installations. Node and the separately provisioned runner-owned Bun
executable use the runner tool cache; npm, Electron, ESLint, and Prettier reuse runner-local caches
without `actions/cache`. Dependency trees remain job-local and are rebuilt from `package-lock.json`
for every source job.

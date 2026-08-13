# ADR 0001: Electron build and packaging toolchain

- Status: accepted
- Date: 2026-08-03

## Decision

Use `electron-vite` for separate Main, Preload, Runtime, and Renderer Vite builds, and `electron-builder` for macOS packaging and native dependency rebuilds.

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

The private GitHub Release path runs on an Apple Silicon macOS runner and publishes an unsigned
arm64 DMG for personal use. Only a pushed `main` commit whose subject exactly matches
`release: v<package-version>` may trigger it; normal commits remain CI-only. The release job must
validate the package version and unused tag, run all release gates, launch the packaged app through
the startup benchmark, verify the DMG, and upload a SHA-256 checksum. Signing and notarization are a
separate public-distribution decision and must not be inferred from the presence of this workflow.

Trusted same-repository PR Electron E2E runs on the repository-level Apple Silicon self-hosted
runner selected by `self-hosted`, `macOS`, `ARM64`, and `caxri-e2e`. The workflow must resolve this
route from GitHub event metadata before PR code executes, require the owner as PR author, actor, and
triggering actor, and use owner-scoped process, desktop-lease, profile, and temporary-directory
cleanup. The `ci:github-hosted-e2e` PR label is the explicit auditable `macos-latest` fallback.
Untrusted events and Release packaging stay GitHub-hosted. Reusing an existing macOS user is an
accepted trust decision and must never be described as isolation from malicious workflow code; see
`docs/self-hosted-runner.md` for operation and incident recovery.

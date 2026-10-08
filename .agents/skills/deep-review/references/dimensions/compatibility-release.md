---
id_prefix: compat
verify: true
skip_when: no IPC/schema/persisted shape, dependency, build/package config, native module, asset, migration, or release workflow touched
---

# Compatibility and Release

Check whether the change works after a real app upgrade and inside the packaged Electron process,
and whether a bad release has a concrete recovery path.

## Quick checklist

- A non-schema IPC/persisted layout, setting, or snapshot change adds a protocol adapter, legacy Host
  control, dual-read/write path, or migration UI only to keep an unpublished build's previous shape
  working, instead of failing clearly toward the documented reset or reinstall workflow (AGENTS.md's
  pre-release policy; this bullet does not apply once the owner declares the public release)
- Database schema changes lack generated checked-in migrations, bundled `?raw` loading, clean-profile
  replay, or an upgrade-path test
- Main, Preload, Runtime, and Renderer assumptions diverge; non-Renderer code uses Renderer-only path
  aliases, or Preload output stops being sandbox-compatible CommonJS
- Packaged code reads source-tree files, ambient cwd paths, system-only fonts/assets, or migration
  files that are not bundled
- Electron, node-pty, better-sqlite3, or Parcel Watcher changes are validated only under host Node,
  not the Electron ABI and packaged Runtime
- Native modules are omitted from `asarUnpack`, production dependencies, rebuild, or package probes
- Dependency/toolchain changes violate the TypeScript 6/7 alias decision or accepted Vite/electron-vite
  compatibility baseline
- Release workflow can publish from a normal commit, skip version/tag/checksum/native/startup gates,
  or imply signing/notarization that does not exist
- A release-sensitive change has no focused build/package/native/startup validation proportional to
  its surface

## Release checks

Emit a `release_checks` item, not a defect, when safety depends on state source cannot prove:

- opening an existing user-data directory created by the previous app version;
- loading native modules from the packaged Runtime and creating a real PTY/SQLite connection;
- launching the unsigned arm64 artifact on the intended macOS target;
- comparing startup/editor benchmarks against the same representative Project and executable.

## How to check

1. Trace both a clean install and upgrade from the immediately previous persisted shape.
2. Trace asset, migration, preload, and native-module paths from the packaged app, not dev cwd.
3. Read `package.json`, `electron.vite.config.ts`, packaging config, and release workflow together.
4. Separate a proved source hazard from an environment fact that belongs in `release_checks`.

## Rule sources

- `AGENTS.md` ("Product invariants": the pre-release no-compatibility-layer policy is authoritative;
  it governs every bullet above that touches IPC, persisted shape, or previous-build compatibility)
- `.agents/skills/build/SKILL.md`
- `.agents/skills/release/SKILL.md`
- `.agents/skills/project-architecture/references/electron-toolchain.md`
- `.agents/skills/project-architecture/references/stack-baseline.md`
- `RELEASING.md` and `.github/workflows/release.yml` when touched

## Not violations

- An additive persisted field with a validated default and old-shape fallback (optional, not required)
- A non-schema IPC/persisted shape change, or a revert that leaves durable state unreadable to the
  reverted code, before the owner has declared the public release, AGENTS.md's documented reset or
  reinstall workflow is the accepted recovery path, not a preserved compatibility layer
- Unsigned/not-notarized local artifacts when the change does not claim public distribution
- Missing full-suite execution during iteration when focused validation covers the change

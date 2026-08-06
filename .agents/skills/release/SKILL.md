---
name: release
description: Prepare and verify a local unsigned Caxri macOS artifact without publishing it. Use when creating a development package, performing a release-readiness check, or validating packaged native modules and startup.
---

# Release Caxri Locally

1. Confirm the requested scope. Never push, publish, notarize, upload, or create a remote release without explicit authorization.
2. Run `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run test:e2e`.
3. Run `bun run package` for the unsigned development application. Use `bun run package:dmg` only when a DMG was explicitly requested.
4. Launch the packaged app with an isolated user-data directory and verify the window, Runtime, PTY, and SQLite native binding.
5. Run the startup performance test against the packaged executable and a representative large repository by setting `CAXRI_BENCHMARK_EXECUTABLE` and `CAXRI_BENCHMARK_PROJECT_ROOT`.
6. Report the local artifact path, architecture, validation commands, benchmark timings, and any signing/notarization limits.

Do not include logs, diagnostics, user roots, terminal output, or credentials in release artifacts beyond the packaged application itself.

## GitHub Release

- `.github/workflows/release.yml` is the only remote release path. It runs after a push to `main`
  only when the head commit subject exactly matches `release: v<package-version>`.
- A normal commit must run CI without packaging or publishing a release.
- The workflow validates the version and tag, runs the full release gates, builds and probes the
  unsigned Apple Silicon DMG, verifies it, and publishes the DMG and SHA-256 checksum.
- Follow `RELEASING.md` when preparing the release commit. Creating or pushing that commit still
  requires explicit user authorization because the push triggers the remote release.

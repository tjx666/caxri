---
name: release
description: Prepare Caxri releases and optional local unsigned macOS artifacts. Use when creating a development package, performing a release-readiness check, or publishing and verifying a GitHub Release.
---

# Release Caxri

1. Confirm the requested scope. Never push, publish, notarize, upload, or create a remote release without explicit authorization.
2. Run non-GUI local gates such as `bun run lint`, `bun run typecheck`, and `bun run test` as needed for release readiness.
3. Never run `bun run test:e2e` or an unscoped Playwright suite locally. GitHub Actions owns full E2E and release-level packaged-app validation so the developer's desktop remains usable.
4. Run `bun run package` only when an unsigned local development application was explicitly requested. Use `bun run package:dmg` only when a local DMG was explicitly requested.
5. Do not launch or benchmark a packaged app locally during a GitHub release. Run focused local Electron coverage only when the changed behavior requires it, and scope Playwright to the smallest relevant file or test name.
6. Report the performed local checks, any requested local artifact path and architecture, remote workflow results, and signing/notarization limits.

Do not include logs, diagnostics, user roots, terminal output, or credentials in release artifacts beyond the packaged application itself.

## GitHub Release

- `.github/workflows/release.yml` is the only remote release path. An exact
  `release: v<package-version>` commit pushed to `main` first runs CI's Linux checks and full macOS
  E2E suite; only a successful CI `workflow_run` may start packaging.
- A normal commit must run the Linux CI checks without macOS E2E, packaging, or publishing.
- The release workflow validates the version and tag, trusts the successful CI gates for the same
  commit SHA, builds and probes the unsigned Apple Silicon DMG, verifies it, and publishes the DMG
  and SHA-256 checksum without repeating the full test suite.
- Follow `RELEASING.md` when preparing the release commit. Creating or pushing that commit still
  requires explicit user authorization because the push triggers the remote release.

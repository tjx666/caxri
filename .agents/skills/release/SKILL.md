---
name: release
description: Prepare Caxri releases and optional local unsigned macOS artifacts. Use when creating a development package, performing a release-readiness check, publishing and verifying a GitHub Release, or previewing/applying the local uninstall/reset plan.
---

# Release Caxri

1. Confirm the requested scope. Never push, publish, notarize, upload, or create a remote release
   without explicit authorization.
2. Run non-GUI local gates such as `bun run lint`, `bun run typecheck`, and focused
   `bun run check` tests as needed for release readiness; the full unit suite runs in CI.
3. Never run `bun run test:e2e` or an unscoped Playwright suite locally. Follow `e2e-testing` for
   focused Electron coverage. GitHub Actions owns explicitly dispatched full E2E and release-level
   packaged-app validation so the developer's desktop remains usable. Ordinary PR and main-push CI
   do not provide a full E2E receipt.
4. Run `bun run package` only when an unsigned local development application was explicitly
   requested. For a requested local versioned DMG, use the repository wrapper so temporary version
   metadata is restored and the artifact is verified:

   ```bash
   bun run .agents/skills/release/scripts/package-local-dmg.ts --version <semver>
   ```

   The wrapper refuses a dirty source tree by default. Pass `--allow-dirty` only when the user
   explicitly wants the current uncommitted source packaged. Use raw `bun run package:dmg` only
   when packaging the version already recorded in `package.json` and separate machine-readable
   verification is unnecessary. Both local commands use the default `include` Source Map flavor.

   Packaging also builds the Linux SSH Host layers (`build:remote-layers`), whose native addons
   compile in Docker. Without Docker, export them first and set `CAXRI_LINUX_NATIVES_DIR`; see
   [Remote SSH](../../../docs/remote-ssh.md#building-the-remote-layers).
5. When acceptance requires packaged-runtime proof but no local artifact was requested, add or
   verify the smallest packaged CI probe, run the relevant build and unpackaged local coverage, and
   report packaged validation as pending remote CI. Do not create a package solely to satisfy a
   local validation checklist.
6. Do not launch or benchmark a packaged app locally during a GitHub release. Run focused local
   Electron coverage only when the changed behavior requires it, and scope Playwright to the
   smallest relevant file or test name.
7. Report the performed local checks, any requested local artifact path and architecture, remote
   workflow results, and signing/notarization limits.

Do not include logs, diagnostics, user roots, terminal output, or credentials in release artifacts
beyond the packaged application itself.

## GitHub Release

- Prepare the version in a clean linked worktree rebased onto the latest `origin/main` with
  `bun run release:prepare -- <major|minor|patch|version>`; never switch the primary checkout's
  branch for a release. The repository-owned command validates
  and updates every coupled manifest, bundled extension engine range, and TypeScript version
  source. It intentionally stops before commit, push, tag, or publication.
- `.github/workflows/release.yml` is the only remote release path. An exact
  `release: v<package-version>` commit landing on `main` must satisfy the release preparation in
  `RELEASING.md` and the exact-release CI profile in `docs/ci-performance.md`. Its lightweight CI
  run preserves the trusted `workflow_run` handoff but skips platform checks and E2E, relying on the
  merged changes' hosted PR checks. That evidence is not a full E2E receipt. Before the pre-public
  runner is removed, the exact frozen candidate must also have one successful `self-hosted-final`
  receipt; after publication, `hosted-full` owns explicit full-suite proof. The fast-path requires
  the commit to match `release:prepare`'s exact path
  set and generated contents; any additional, missing, or modified content falls back to normal
  main-push CI. Only a successful CI `workflow_run` for the same commit may start packaging. `main`
  requires the `guards` status check with no bypass, so the release commit reaches `main` through a
  pull request squash-merged with the exact release subject, not a direct push; see `RELEASING.md`.
- Normal commits follow the event plan in `docs/ci-performance.md`. Source pushes run hosted checks
  but never start full E2E, package, or publish a release automatically.
- The release workflow validates the version and tag, builds the release-signed Android update APK
  that Desktop serves to paired phones (`docs/mobile/update.md`), rebuilds the unsigned Apple Silicon
  app in `include` and `omit` Source Map flavors, and publishes both DMGs with one SHA-256 checksum
  each. The canonical `Caxri-<version>-arm64.dmg` is the Source Map build and owns the focused
  packaged-app probe; the `-nosourcemap` asset receives structural, manifest, architecture, disk
  image, and checksum verification without duplicating the packaged Electron smoke. Packaged-app
  verification remains a release responsibility; product checks run in PR CI, while full E2E uses
  the separate explicit route above. Runner routing, availability, trust, and recovery follow
  `docs/self-hosted-runner.md`. A release step
  that fails only on the runner is diagnosed there over SSH, as its Remote diagnosis section
  describes, before any rerun.
- Follow `RELEASING.md` when preparing the release commit and opening its pull request. Creating that
  commit, opening its pull request, and merging it still require explicit user authorization because
  the merge triggers the remote release.
- After the GitHub Release publishes successfully, install it locally by default with
  `bun run install:caxri` (standing owner preference) and report the installed version. Skip only
  when the user asked not to install or the release itself failed.
- Treat an explicit install request as authorization to end every task owned by the installed
  `/Applications/Caxri.app`, stop its Host, and force-terminate only its exact bundle processes if
  graceful shutdown fails. Do not pause for separate permission when active tasks or the native
  quit confirmation are detected: `install:caxri` uses the installed version-matched CLI first so
  task shutdown is non-interactive, then applies the exact-path signal fallback before replacement.

## Local uninstall

Preview the pre-release local reset/uninstall plan with `bun run uninstall:caxri`. Apply it only
after explicit authorization with `bun run uninstall:caxri -- --yes`. The command archives known
Caxri installation state, application paths, and managed development profiles beneath the primary
checkout's sibling `../caxri-uninstall-archives`, records every original path in `manifest.json`,
strips Caxri-owned Agent hook entries from the Claude Code and Codex hook configs (foreign hooks
stay), and never targets Project folders or user files.

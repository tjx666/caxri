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
   [SSH Host](../../../docs/ssh-host.md#building-the-remote-layers).
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
- `release:prepare` refuses to run when the latest completed CI run on `main` for a non-release
  commit failed, because the release fast-path trusts the merged PRs' non-required `checks`. Check
  by hand with `gh run list --workflow ci.yml --branch main --status completed --limit 5`; land
  the fix for a red `main` before releasing.
- Merge the next `release:` PR only after the earlier Release run has published. If that run
  failed, land the fix first: a version prepared from the same tree fails the same way and burns
  its version number too. Cancel an earlier run only once a newer release supersedes it.
- `.github/workflows/release.yml` is the only remote release path. An exact
  `release: v<package-version>` commit landing on `main` must satisfy the release preparation in
  `RELEASING.md` and the exact-release CI profile in `docs/ci-performance.md`. Its lightweight CI
  run preserves the trusted `workflow_run` handoff but skips platform checks and E2E, relying on the
  merged changes' hosted PR checks. The current release-readiness evidence is the complete hosted
  unit/integration suite, build and native checks, package validation, targeted Electron smoke, and
  the hosted no-publish Release rehearsal. It deliberately does not include or require a full E2E
  receipt. `hosted-full` remains a future manual diagnostic route: every dispatch needs fresh,
  explicit maintainer authorization and is not a prerequisite for runner removal, GO, repository
  publication, or anonymous review. The fast-path requires the commit to match `release:prepare`'s exact path
  set and generated contents; any additional, missing, or modified content falls back to normal
  main-push CI. Only a successful CI `workflow_run` for the same commit may start packaging. `main`
  requires the `guards` status check with no bypass, so the release commit reaches `main` through a
  pull request squash-merged with the exact release subject, not a direct push; see `RELEASING.md`.
- Normal commits follow the event plan in `docs/ci-performance.md`. Source pushes run hosted checks
  but never start full E2E, package, or publish a release automatically.
- Before publishing a change to `.github/workflows/release.yml`, run
  `rtk vitest run scripts/__tests__/release-workflow-contract.test.ts scripts/__tests__/release-android-assets.test.ts`
  alongside the changed-file check. These contracts read workflow YAML as data, so import-based
  affected-test selection does not discover them.
- The release workflow validates the version and tag, builds the release-signed Android update APK
  that Desktop serves to paired phones (`docs/mobile/update.md`), rebuilds the unsigned Apple Silicon
  app in `include` and `omit` Source Map flavors, and publishes both DMGs plus the exact bundled
  APK as `Caxri-Mobile-<version>-android-arm64.apk`, each with one SHA-256 checksum. Verify the APK
  appears in the Release assets as well as inside Desktop; an embedded-only APK does not provide
  the first-install download path. The canonical `Caxri-<version>-arm64.dmg` is the Source Map build and owns the focused
  packaged-app probe; the `-nosourcemap` asset receives structural, manifest, architecture, disk
  image, and checksum verification without duplicating the packaged Electron smoke. Packaged-app
  verification remains a release responsibility; product checks and release packaging run on
  GitHub-hosted runners. A future full E2E run uses the separately authorized route above and does
  not replace the release workflow's own targeted package validation.
- Track Android build progress in the build step of the active release or rehearsal job. Android
  backfill is a separate route. When a hosted build is anomalously stalled and REST log archives are
  unavailable, inspect that step in an existing authenticated Actions browser session. Streamed
  build stdout can reveal a fatal runtime error while the job is still active.
- For a fatal JVM signal during Gradle or R8, preserve the attempt, step, and public stdout
  coordinates. Leave JVM error reports and core dumps untouched because they may contain
  environment values. If a confirmed fatal error leaves the job without a success path and it
  remains running, preserve the evidence and cancel that attempt through the authorized workflow.
  Treat this as a hosted-only toolchain/runtime failure under
  [pull-request](../pull-request/SKILL.md)'s CI failure rules.
  Obtain an independent verdict before exactly one exact-SHA replay of the failed hosted job;
  keep its inputs and budgets unchanged.
  A repeated runtime crash or a product assertion failure ends that retry path and requires
  investigation.
- Follow `RELEASING.md` when preparing the release commit and opening its pull request. Creating that
  commit, opening its pull request, and merging it still require explicit user authorization because
  the merge triggers the remote release. After the merge, `bun run scripts/watch-ci.ts --sha <merge commit>`
  follows the CI run and the Release run it triggers to completion in one watcher.
- Do not install a published release locally. The owner updates through the in-app updater, so the
  release ends with the Release URL and its assets in the report. Run `install:caxri` only on the
  user's explicit request, and never from an Agent Session inside the installed Caxri: quitting
  Caxri ends that Session together with the install it started, leaving the old version in place.

## Existing-release Android backfill

For a requested Android download missing from an already published Release, use the canonical
workflow's `android_release_tag` input on `main` after the backfill route is merged. Follow
[RELEASING.md](../../../RELEASING.md#backfill-android-for-an-existing-release). The route pins and
rechecks the published tag, independently verifies the release signing certificate and arm64 APK,
and resumes partial publication only when existing assets match exactly. It refuses asset
replacement. Inspect the
published APK and checksum, download them anonymously, then verify installation on a disposable
Android emulator. Do not claim an older DMG contains the rebuilt APK; preserve the source-commit
explanation in its Release notes. Leave unrelated failed Desktop publication checks intact.

## Local uninstall

Preview the pre-release local reset/uninstall plan with `bun run uninstall:caxri`. Apply it only
after explicit authorization with `bun run uninstall:caxri -- --yes`. The command archives known
Caxri installation state, application paths, and managed development profiles beneath the primary
checkout's sibling `../caxri-uninstall-archives`, records every original path in `manifest.json`,
unloads and archives Caxri's per-user LaunchAgents (the Claude 5-hour window job), strips
Caxri-owned Agent hook entries from the Claude Code, Codex, and Grok hook configs (foreign hooks stay),
and never targets Project folders or user files. After a new non-empty archive completes
without a target move failure, it keeps that archive and deletes older completed archives; unsafe,
incomplete, non-matching, and concurrently newer entries are retained.

# Releasing Caxri

Caxri currently publishes an unsigned Apple Silicon DMG for personal use. The event- and
change-specific CI profile, including whether E2E runs, is owned by the decision matrix in
[`docs/ci-performance.md`](docs/ci-performance.md). A commit whose subject is exactly
`release: v<package-version>` selects a lightweight CI trust gate that skips platform checks and
E2E, relying on the merged changes' PR CI. This fast-path requires the changed-file set to match
the exact paths and generated contents from `release:prepare`; any additional, missing, or modified
content falls back to normal main-push CI. After that gate succeeds, the release runner builds the
DMG and creates the matching Git tag and GitHub Release. Runner labels, availability, and recovery are owned by
[`docs/self-hosted-runner.md`](docs/self-hosted-runner.md).

`main` requires the `guards` status check to pass before anything merges
([ADR 0011](docs/adr/0011-required-merge-guards.md)), with no bypass for any actor, so the release
commit can no longer be pushed to `main` directly; it goes through a pull request like any other
change.

## Create a release

Update the root application version before committing. The public API, Agent skill package, CLI
workspace, bundled extension versions, bundled extension `engines.caxri` ranges, and version
sources must move in lockstep. The preparation command validates that contract before writing, and
still requires a clean `main` synchronized with its upstream; create the release branch after it
runs, not before:

```bash
bun run release:prepare -- patch # also accepts minor, major, or an explicit newer SemVer
version="$(node -p 'require("./package.json").version')"
git checkout -b "release/v${version}"
git add package.json packages/agent-skills/package.json packages/agent-skills/src/version.ts \
  packages/client/package.json packages/extension-api/package.json apps/cli/package.json \
  apps/cli/src/version.ts apps/desktop/package.json apps/mobile/package.json \
  apps/server/package.json extensions/{fixture,git,status}/package.json
git commit -m "release: v${version}"
git push -u origin "release/v${version}"
gh pr create --title "release: v${version}" --body "" --base main
# wait for the `guards` status check to pass, then squash-merge with the exact release subject so
# `.github/workflows/release.yml` and scripts/ci-retry-policy.ts's exact-release check still match:
gh pr merge --squash --subject "release: v${version}" --body ""
```

The preparation command refuses a dirty worktree, a branch other than `main`, or a local `main`
that does not match its configured upstream. It validates every current version source before
writing, updates all coupled manifests, extension compatibility ranges, and TypeScript constants,
and restores already-written files if a later write fails. It never commits, tags, pushes, or
publishes; those remain explicit steps because the release commit triggers remote publication. A
squash-merge produces one new commit on `main` with the exact chosen subject and the same file-set
diff as the branch's single commit, so it satisfies `isVerifiedReleaseCommit`'s exact-subject and
exact-file-set check exactly like the old direct push did.

The lightweight CI run rechecks both the trusted exact-release event and the exact prepared output
without repeating platform checks or E2E. The downstream workflow rejects a release when the commit
subject and package version differ, or when the tag already exists. It builds an arm64 DMG, launches
the packaged application through the startup benchmark, verifies the disk image, writes a SHA-256
checksum, and publishes both files to GitHub Releases.

Every CI and Release stage follows the self-hosted availability contract above. The Release job
uses a short-lived `contents: write` token and does not persist checkout credentials.

## Install a release

Browser downloads of the unsigned DMG receive a `com.apple.quarantine` flag, so Gatekeeper reports
the app as "damaged". Install from the terminal instead: `gh` downloads carry no quarantine flag:

```bash
bun run install:caxri              # latest release; add `-- --tag vX.Y.Z` for a specific one
```

The installer downloads the DMG and checksum with `gh`, verifies the SHA-256 (a Release without its
`.sha256` aborts the install; pass `-- --skip-checksum` to install it anyway, with a warning), stops
tasks through the installed version-matched CLI, quits Caxri without an interactive task prompt, replaces
`/Applications/Caxri.app`, and strips any quarantine attribute defensively. A failed graceful stop
falls back to signals scoped to exact processes inside that installed bundle. For an artifact that
was already downloaded with a browser, clear the flag once with
`xattr -dr com.apple.quarantine /Applications/Caxri.app`.

## Current distribution boundary

The DMG is intentionally unsigned. After downloading it on your own Mac, verify the accompanying
SHA-256 file before opening the application. Gatekeeper will identify it as an unnotarized app; use
the explicit override in macOS Privacy & Security only for an artifact you built and verified.

Public distribution requires an Apple Developer Program membership, a Developer ID Application
certificate, hardened-runtime entitlements, GitHub Actions secrets for signing and notarization,
and Gatekeeper verification of the final DMG. Add that workflow only when Caxri is distributed to
other users.

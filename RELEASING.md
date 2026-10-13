# Releasing Caxri

Caxri currently produces two unsigned Apple Silicon DMGs. The canonical asset
includes Source Maps; the `-nosourcemap` asset is the explicit smaller flavor. The event- and
change-specific CI profile, including whether E2E runs, is owned by the decision matrix in
[`docs/ci-performance.md`](docs/ci-performance.md). A commit whose subject is exactly
`release: v<package-version>` selects a lightweight CI trust gate that skips platform checks and
E2E, relying on the merged changes' PR CI. This fast-path requires the changed-file set to match
the exact paths and generated contents from `release:prepare`; any additional, missing, or modified
content falls back to normal main-push CI. PR and main-push CI provide hosted checks, not a full E2E
receipt. Current release readiness comes from the complete hosted unit/integration suite, build and
native checks, package validation, targeted Electron smoke, and the hosted no-publish Release
rehearsal. `hosted-full` remains a future manual diagnostic route; every dispatch needs fresh,
explicit maintainer authorization and is not a prerequisite for runner removal, GO, repository
publication, or anonymous review. After the release gate succeeds, a GitHub-hosted Apple Silicon
runner builds the DMGs and creates the matching Git tag and GitHub Release.

`main` requires the `guards` status check to pass before anything merges
([ADR 0011](docs/adr/0011-required-merge-guards.md)), with no bypass for any actor, so the release
commit can no longer be pushed to `main` directly; it goes through a pull request like any other
change.

## Create a release

Update the root application version before committing. The public API, Agent skill package, CLI
workspace, bundled extension versions, bundled extension `engines.caxri` ranges, and version
sources must move in lockstep. The preparation command validates that contract before writing.
Run it in a clean linked worktree (`switch-worktree`), never by switching the primary checkout's
branch; it fetches `origin/main` and refuses any HEAD other than that commit, so rebase first:

```bash
git rebase origin/main # in the release worktree; release:prepare fetches and verifies the match
bun run release:prepare -- patch # also accepts minor, major, or an explicit newer SemVer
version="$(node -p 'require("./package.json").version')"
git switch -c "release/v${version}"
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

The preparation command refuses a dirty worktree or a HEAD that does not match the freshly fetched
`origin/main`; the branch name is not checked. It validates every current version source before
writing, updates all coupled manifests, extension compatibility ranges, and TypeScript constants,
and restores already-written files if a later write fails. It never commits, tags, pushes, or
publishes; those remain explicit steps because the release commit triggers remote publication. A
squash-merge produces one new commit on `main` with the exact chosen subject and the same file-set
diff as the branch's single commit, so it satisfies `isVerifiedReleaseCommit`'s exact-subject and
exact-file-set check exactly like the old direct push did.

A `release: v…` push runs CI in its own commit-scoped concurrency group, so a later merge to `main`
cannot cancel it while it waits for the runner. The lightweight CI run rechecks both the trusted exact-release event and the exact prepared output
without repeating platform checks or E2E. The downstream workflow rejects a release when the commit
subject and package version differ, or when the tag already exists. It rebuilds the same commit and
version with `CAXRI_SOURCE_MAPS=include` and `CAXRI_SOURCE_MAPS=omit`, placing each app and DMG in an
isolated output directory. It launches only the canonical Source Map application through the focused
packaged smoke, verifies both disk images and Server manifests, writes one SHA-256 checksum per DMG,
and publishes all four files to GitHub Releases. This does not run the complete E2E suite.

The production Release job uses a disposable GitHub-hosted Apple Silicon runner, a short-lived
`contents: write` token, and non-persisted checkout credentials. The same packaging and targeted
smoke steps are exercised by the read-only no-publish rehearsal before publication.

## Install a release

Browser downloads of the unsigned DMG receive a `com.apple.quarantine` flag, so Gatekeeper reports
the app as "damaged". Install from the terminal instead: `gh` downloads carry no quarantine flag:

```bash
bun run install:caxri              # latest Source Map release
bun run install:caxri -- --no-sourcemap # latest no-map release
bun run install:caxri -- --tag vX.Y.Z   # specific Source Map release
```

The installer selects exactly one requested flavor and its checksum with `gh`; zero or multiple
matching DMGs abort instead of choosing the first directory entry. Source Map is the default and
`--no-sourcemap` is explicit. It verifies the SHA-256 (a Release without its
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

An unsigned DMG can be offered for public download, but recipients must handle the Gatekeeper
friction described above. Signing and notarization may be added later to remove that friction; they
are not a prerequisite for making the approved artifacts downloadable. Distribution permissions
come only from the published `LICENSE` and any explicit commercial authorization, not from this
release procedure.

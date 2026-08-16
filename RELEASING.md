# Releasing Caxri

Caxri currently publishes an unsigned Apple Silicon DMG for personal use. A normal commit runs the
self-hosted CI checks only. A commit whose subject is exactly
`release: v<package-version>` also runs the full macOS E2E suite on the repository self-hosted
`m2-24` runner; after that CI succeeds, the same runner builds the DMG and creates the matching Git
tag and GitHub Release.

## Create a release

Update the root application version before committing. The CLI workspace version and
`packages/cli/src/version.ts` must move in lockstep — `packages/cli/src/__tests__/artifact.test.ts`
fails the release CI when any of the three diverge:

```bash
pnpm version patch --no-git-tag-version --no-git-checks
version="$(node -p 'require("./package.json").version')"
(cd packages/cli && npm version "${version}" --no-git-tag-version)
sed -i '' "s/CLI_VERSION = '.*'/CLI_VERSION = '${version}'/" packages/cli/src/version.ts
git add package.json packages/cli/package.json packages/cli/src/version.ts
git commit -m "release: v${version}"
git push origin main
```

CI rejects the release path unless its self-hosted gates and full macOS E2E suite pass. The
downstream workflow then rejects a release when the commit subject and package version differ or
when the tag already exists. It builds an arm64 DMG, launches the packaged application through the
startup benchmark, verifies the disk image, writes a SHA-256 checksum, and publishes both files to
GitHub Releases without repeating the CI gates.

Every CI and Release stage requires the online `m2-24` runner. There is no GitHub-hosted fallback:
an offline runner leaves the workflow queued. The Release job uses a short-lived `contents: write`
token and does not persist checkout credentials.

## Install a release

Browser downloads of the unsigned DMG receive a `com.apple.quarantine` flag, so Gatekeeper reports
the app as "damaged". Install from the terminal instead — `gh` downloads carry no quarantine flag:

```bash
bun run install:caxri              # latest release; add `-- --tag vX.Y.Z` for a specific one
```

The installer downloads the DMG and checksum with `gh`, verifies the SHA-256, quits a running
Caxri, replaces `/Applications/Caxri.app`, and strips any quarantine attribute defensively. For an
artifact that was already downloaded with a browser, clear the flag once with
`xattr -dr com.apple.quarantine /Applications/Caxri.app`.

## Current distribution boundary

The DMG is intentionally unsigned. After downloading it on your own Mac, verify the accompanying
SHA-256 file before opening the application. Gatekeeper will identify it as an unnotarized app; use
the explicit override in macOS Privacy & Security only for an artifact you built and verified.

Public distribution requires an Apple Developer Program membership, a Developer ID Application
certificate, hardened-runtime entitlements, GitHub Actions secrets for signing and notarization,
and Gatekeeper verification of the final DMG. Add that workflow only when Caxri is distributed to
other users.

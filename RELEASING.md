# Releasing Caxri

Caxri currently publishes an unsigned Apple Silicon DMG for personal use. A normal commit runs the
platform-neutral CI checks only. A commit whose subject is exactly
`release: v<package-version>` also runs the full macOS E2E suite on the repository self-hosted
`m2-24` runner; after that CI succeeds, the same runner builds the DMG and creates the matching Git
tag and GitHub Release.

## Create a release

For the first `0.1.0` release, after the release workflow itself is on `main`:

```bash
git commit --allow-empty -m "release: v0.1.0"
git push origin main
```

For later releases, update both `package.json` and `package-lock.json` before committing:

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
version="$(node -p 'require("./package.json").version')"
git commit -m "release: v${version}"
git push origin main
```

CI rejects the release path unless its platform-neutral gates and full macOS E2E suite pass. The
downstream workflow then rejects a release when the commit subject and package version differ or
when the tag already exists. It builds an arm64 DMG, launches the packaged application through the
startup benchmark, verifies the disk image, writes a SHA-256 checksum, and publishes both files to
GitHub Releases without repeating the CI gates.

Both macOS stages require the online `m2-24` runner. There is no automatic GitHub-hosted fallback
for release commits: an offline runner leaves the workflow queued instead of spending paid macOS
minutes. The Release job uses a short-lived `contents: write` token and does not persist checkout
credentials.

## Current distribution boundary

The DMG is intentionally unsigned. After downloading it on your own Mac, verify the accompanying
SHA-256 file before opening the application. Gatekeeper will identify it as an unnotarized app; use
the explicit override in macOS Privacy & Security only for an artifact you built and verified.

Public distribution requires an Apple Developer Program membership, a Developer ID Application
certificate, hardened-runtime entitlements, GitHub Actions secrets for signing and notarization,
and Gatekeeper verification of the final DMG. Add that workflow only when Caxri is distributed to
other users.

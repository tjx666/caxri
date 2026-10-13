---
kind: adr
status: accepted
---

# GitHub-hosted CI with explicitly authorized full E2E

- Date: 2026-10-14
- Refs: [issue caxri#2097](https://github.com/tjx666/caxri/issues/2097), [issue caxri#2105](https://github.com/tjx666/caxri/issues/2105)
- Supersedes: [ADR 0011](0011-required-merge-guards.md)

## Context

ADR 0011 made `guards` a required GitHub-hosted check but described the ordinary `checks` and `e2e`
jobs as non-required work on one self-hosted macOS runner. That architecture tied repository
validation and releases to a maintainer machine, exposed untrusted pull-request workflow changes to
that machine, and made private machine state part of the build contract.

The repository is preparing for public visibility. Active CI and Release work therefore need a
disposable, reproducible execution environment. Full Electron E2E remains unusually expensive and
is not required for every change: affected behavior is covered by focused specs, while a complete
suite is an explicit diagnostic or release-readiness operation.

## Decision

`guards` remains required for every pull request and continues to run on a disposable
GitHub-hosted Linux runner. Direct pushes to `main` remain impossible because the exact pushed SHA
cannot already have that required status. Every change, including release preparation and
documentation-only work, continues through a pull request.

All active jobs in `.github/workflows/ci.yml` and `.github/workflows/release.yml` run on disposable
GitHub-hosted runners. macOS jobs pin the repository's supported image and install their toolchain,
dependencies, native modules, browser shell, media tools, and Android tooling from tracked inputs.
They do not rely on a maintainer machine, a persistent workspace, or a repository self-hosted
runner. The Release workflow retains its trusted-actor, exact-SHA, checksum, and no-publish
rehearsal boundaries.

Pull requests and pushes to `main` run the hosted check scope selected for their diff. Ready source
pull requests may run affected unit and integration coverage; global configuration paths and main
pushes ordinarily run the full non-E2E check scope. A verified exact release push reuses the merged
release PR's evidence and skips duplicate platform checks. No pull request or push starts the
complete Electron E2E suite automatically. A separate manual `hosted-smoke` route runs the fixed
targeted smoke set; affected E2E spec selection is recorded for review but does not dispatch those
specs.

The complete Electron E2E suite exists only behind the manual `hosted-full` dispatch. Each run
requires fresh maintainer authorization and validates both `actor` and `triggering_actor`; it is not
a default CI, merge, Runner-retirement, repository-visibility, or release gate. The repository does
not treat the mere existence of that route as authorization to run it.

The historical Renderer performance baseline came from the retired self-hosted runner and is
`armed: false`. Explicit hosted full validation still records current receipts and enforces fixed
per-run thresholds, but the cross-run historical comparison cannot block until a same-image hosted
corpus is collected and reviewed. The separate performance-trend workflow is manual-only during the
publication freeze.

The repository self-hosted runner is retired after hosted CI and the Release no-publish rehearsal
pass on the audited SHA. No tracked workflow may retain a route to it. Runner removal and historical
Actions cleanup remain separately audited destructive operations.

## Consequences

- CI and Release can run from a clean GitHub-hosted image without access to a maintainer machine.
- Hosted checks consume GitHub Actions minutes and cold-install time, so one delivery keeps one
  current exact-head run and cancels only obsolete replacements.
- Ordinary changes keep focused validation and never incur a complete E2E run implicitly.
- A future full E2E run is deliberate, attributable, and separately authorized.
- Performance trend comparisons remain non-blocking until hosted evidence replaces the old
  self-hosted corpus.
- ADR 0011's required `guards`, no-bypass, and pull-request-only merge decisions remain in force;
  this ADR replaces its runner-routing, cost, and fast-merge assumptions.

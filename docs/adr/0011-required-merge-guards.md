---
kind: adr
status: accepted
---

# A required `guards` check replaces direct pushes to `main`

- Date: 2026-09-29
- Refs: [issue #1438](https://github.com/tjx666/caxri/issues/1438)

## Context

[PR #1427](https://github.com/tjx666/caxri/pull/1427) added gitleaks, the source-size ratchet, and
the documentation check as CI and pre-commit gates. `main` had no required status check and no merge
queue, so those gates only ran when an agent chose to run them: a merge or a direct push that skipped
CI, or a `--no-verify` commit, still reached `main`. [PR #1443](https://github.com/tjx666/caxri/pull/1443)
demonstrated the failure mode for real — it added binary `.woff2` fixtures whose push CI was skipped,
and the ESLint config's `**/scripts/**/*.*` override then failed every later PR's full platform
checks (`main` run `36414896762`) until a follow-up PR fixed the ignore list. The same PR also missed a
pnpm catalog member update, breaking the full unit suite for another full-checks run
(`36418190877`) before it was fixed.

The existing self-hosted `checks`/`e2e` job cannot become the required check: it costs 20-25 minutes
of the one self-hosted runner every parallel session shares, and the `pull-request` skill's fast-merge
exception exists specifically so a locally-verified diff does not have to wait behind it. Making it
required would either remove that exception or make "required" mean "sits in a queue," neither of
which fixes the actual problem: the three cheap gates never being skippable.

## Decision

A new `guards` job (`.github/workflows/guards.yml`) runs gitleaks (scoped to the pushed commits),
`docs-check`, and `source-size-ratchet` on a disposable `ubuntu-latest` GitHub-hosted runner, with no
`paths` filter on either its `push: branches: [main]` or `pull_request` trigger — a required check
that some commits never request never reports, and GitHub then blocks the merge on that PR forever.
It installs only the root workspace's own dependencies
(`pnpm install --filter @caxri/workspace --frozen-lockfile --ignore-scripts`, the one place
`docs-check`'s `yaml` import comes from) instead of the full monorepo tree, and skips postinstall
scripts entirely since none of the three gates need a compiled native module or a downloaded browser.
`scripts/prepare-gitleaks.ts` gained pinned Linux checksums (`gitleaksReleaseKey` accepted only
`darwin` before) so the same script that provisions gitleaks for local hooks and the self-hosted
runner also provisions it here. Estimated cost: roughly 100 GitHub Actions `ubuntu-latest`-minutes a
month (this repository's own PR/push cadence, one run around 1 minute) — negligible against a private
repository's free-tier or paid-plan minutes, and unrelated to the metered self-hosted runner. The
self-hosted `checks`/`e2e` job stays non-required; the `pull-request` skill's fast-merge paths for
code and Renderer styling are unchanged.

`scripts/apply-required-status-check-ruleset.ts` adds a `required_status_checks` rule for the
`guards` context to the existing `main-protection` ruleset (id `23388173`) instead of creating
separate classic branch protection — GitHub allows only one `required_status_checks` rule per
ruleset, so the script merges into it (and is idempotent re-run against an already-required
context). That ruleset's `bypass_actors` list is already empty, so the required check already applies
to the repository owner with no further configuration. The script defaults to a dry run (reads the
ruleset, prints the rule it would add, changes nothing) and only mutates GitHub behind an explicit
`--apply` flag, then re-reads the ruleset back to confirm the change stuck.

Direct pushes to a branch with a required status check are rejected outright — the pushed commit has
never had that check run against its exact SHA, so GitHub has nothing to point to — regardless of
whether "require a pull request" is separately enabled. Every flow that used to push straight to
`main` moves to "open a PR, let `guards` pass, merge it":

- **Release commits** (`RELEASING.md`, the `release` skill): push the `release: v<version>` commit to
  a branch, open a PR, and merge with `gh pr merge --squash --subject "release: v<version>" --body ""`
  once `guards` passes. `scripts/ci-retry-policy.ts`'s `isVerifiedReleaseCommit` check only inspects
  the landed commit's subject and exact file-set diff against its parent, so a squash-merged commit
  satisfies it exactly like the old direct push did; `.github/workflows/release.yml` still triggers
  off the resulting `push` event on `main`.
- **Documentation-only changes** (`AGENTS.md`, the `pull-request` skill's fast-merge section): move
  from a direct commit-and-push on `main` to a PR that merges once `guards` passes, without waiting
  for the non-required self-hosted `checks` job.
- **Small fixes/minor features "committed directly on `main`"** (`AGENTS.md`'s standing orders): the
  same authorization now means "open a PR and merge it once `guards` passes," since the branch no
  longer accepts a raw push at all.

No CI job or repository script performs a raw `git push` to `main` itself (verified by inspecting
every workflow and `scripts/**`), so this is the complete set of flows that needed adaptation.

Applying the ruleset change and running the blocked-merge demonstration (a PR with a broken docs link
or a planted secret, showing `guards` fails and blocks the merge) is deliberately left to whoever
merges the integration PR that lands this ADR: the required check must exist on `main` before a
demonstration PR against it means anything.

## Consequences

- A contributor (human or agent) can no longer push directly to `main` under any authorization,
  including the repository owner's — `bypass_actors: []` makes the required check unconditional.
  Every change, including a one-line documentation fix, goes through a PR merge.
- `guards` duplicates gitleaks and `docs-check` work the self-hosted `checks` job also performs when
  it runs; this is intentional redundancy, not a defect — `guards` is the check that must never be
  skippable, `checks` is the one that may be skipped by the existing fast-merge exception.
- A future gate this repository wants to make unbypassable (a new secret-scanning rule, a new size or
  lint ratchet) belongs in `guards`, not in `checks`, or it inherits the same gap this ADR closes.

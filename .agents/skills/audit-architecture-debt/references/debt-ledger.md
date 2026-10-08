# Architecture debt ledger

A persistent, repo-tracked record of audit findings at `docs/architecture-debt.md`, so repeat
audits revalidate known debt instead of rediscovering it from scratch. Maintaining the ledger is
opt-in: write or update it only when the user asks to persist findings across runs. Without that
request, the audit stays fully read-only and reports conversationally.

## Ledger entry shape

```markdown
### AD-owner-git-service-split: [OPEN · Architecture debt · M]

- **Summary:** One-sentence user- or developer-visible consequence.
- **Evidence:** `path/to/file.ts:42` plus the load-bearing consumer, refreshed on every revalidation.
- **First seen:** 2026-08-08 @ b9c2482 · **Last verified:** 2026-08-08 @ b9c2482
- **Remediation target / Acceptance:** Same content as the report finding.
```

- **ID**: `AD-<dimension-prefix>-<slug>`. The slug names the root cause, never a file path or line
  number, so the ID survives moves and refactors. Assigned at first sighting; never renumbered or
  reused, even after resolution.
- **Status**: `OPEN` (revalidated as present), `RESOLVED` (re-verified gone; keep the entry with the
  resolving commit), or `STALE` (evidence no longer matches and the claim could not be revalidated).
  "New" is not a status: a new finding is `OPEN` with `First seen` equal to the current run.
- Severity category and effort (S/M/L) follow the report-format definitions.

## Repeat-run workflow

When the ledger file exists, regardless of whether ledger writing was requested:

1. Treat every entry as an unverified lead, exactly like an external report (SKILL.md step 1):
   revalidate its evidence against the current tree before the new-debt sweep, highest severity
   first.
2. Report findings in three explicit groups: **still present** (revalidated OPEN), **resolved**
   (with the resolving commit when identifiable), and **new** (first seen this run).
3. Deduplicate new candidates against existing IDs by root cause before assigning a new ID.

When ledger writing is authorized, update statuses and `Last verified` stamps, append new entries,
and never delete resolved ones: the resolution history is the point. The ledger is the only file a
ledger-mode audit may write; user-owned worktree changes to it are preserved like any other file.

After an authorized fix wave (SKILL.md "When fixes are authorized"), re-verify each fixed finding
and flip its ledger entry to `RESOLVED` in the same pass; do not mark entries resolved on the
strength of an unverified diff.

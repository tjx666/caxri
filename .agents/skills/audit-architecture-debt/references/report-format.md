# Architecture debt report format

Use the smallest report that preserves evidence. Keep the conversational summary concise; write a longer artifact only when the user asks for one.

## Conclusion

State whether the architecture is sound, needs targeted repair, or warrants a broader refactor. Name the two or three dominant themes and the current scope/commit.

## Findings

Order findings by severity and leverage. Use this shape:

```markdown
### F1 — [Severity · Category] User-visible consequence

- **Context:** Why this file or boundary matters.
- **Evidence:** `path/to/file.ts:42` and the relevant consumer/test.
- **Scenario:** A concrete sequence that exposes the problem.
- **Cause:** The ownership, state, lifecycle, or dependency path that creates it.
- **Why this is debt now:** Current impact or repeated change cost; avoid hypothetical future-only claims.
- **Remediation target:** The smallest architectural outcome, without unapproved implementation detail.
- **Acceptance:** Focused regression, benchmark, log assertion, or observable behavior that proves the debt is removed.
```

If evidence is incomplete, move the item to **Open hypotheses** and name the missing proof. Never inflate a coverage gap into a bug.

For a subagent-backed audit, include only findings with an independent disposition. The root agent must still recheck the final causal path and current line numbers.

## Coverage matrix

```markdown
| Dimension         | Result         | Evidence or boundary                       |
| ----------------- | -------------- | ------------------------------------------ |
| Process ownership | Finding F2     | `src/shared/ipc/...`, Runtime dispatcher   |
| Persistence       | Checked, clean | Schema and migration package path verified |
```

Include every dimension from `audit-dimensions.md`. "Not in requested scope" is acceptable when explained.

## Keep as designed

List intentional tradeoffs that were checked and should not be "fixed." This protects Caxri from generic modernization advice that would weaken its product or security model.

## Historical revalidation

When historical sessions or old reports were used, list only the meaningful outcomes:

- still present;
- changed shape;
- resolved in the current tree;
- could not be revalidated.

Do not paste session prompts or transcript paths unless the user asks for the inventory.

## Validation boundary

List read-only commands, focused tests, probes, benchmarks, or documentation checks performed. Separately state what was not run and why. A passing validation narrows risk; it does not erase a source-proven finding outside its coverage.

For subagent-backed audits, also state:

- discovery groups and any missing group;
- candidate, confirmed, false-positive, downgraded, stale, and unresolved counts;
- whether the coverage challenger ran;
- whether HEAD or the worktree changed during the audit.

---
id_prefix: flow
verify: false
skip_when: never in deep PR mode
---

# Workflow

Report objective repository and GitHub state separately from code findings.

## Quick checklist

- Non-trivial work has a relevant GitHub issue when project practice expects one; Caxri does not use
  Linear
- PR title/body and linked issue still describe the actual diff, acceptance criteria, trade-offs,
  and scope after review rounds
- PR targets `main`, is not unexpectedly draft, and has no merge conflict
- Required CI checks are green; authorization/infrastructure failures are distinguished from code
  failures, and pending checks are reported as pending
- Every review thread is fully paginated and unresolved threads are reported; stale threads are
  checked against the current head and current line before treating them as blockers
- The PR head SHA did not change during review; if it changed, the code review is stale and must be
  rerun against the new head
- Commit messages and all code-facing PR content are in English
- Release-sensitive changes describe the focused native/package/upgrade/benchmark evidence needed
  before shipping

## How to check

1. Use `gh pr view` for current head, base, body, draft, mergeability, review decision, and checks.
2. Use `gh api graphql` to fully paginate review threads and count unresolved current threads.
3. Compare issue/PR claims with the reviewed diff and test evidence.
4. Fetch the head SHA again immediately before reporting.

## Not violations

- Pending checks on an active draft, when clearly reported as pending
- An external authorization failure, when reported separately from code defects
- Missing GitHub issue for a truly trivial maintenance change

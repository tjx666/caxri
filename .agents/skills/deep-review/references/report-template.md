# Deep Review Report

Write in the conversation's language. Lead with the conclusion. Keep the report compact enough to
scan, but never hide a confirmed blocker or an unverified release dependency.

## Required structure

```markdown
# Deep Review

**Conclusion**: {direct outcome and biggest risk, or clean result}
**Scope**: {target, head SHA/range, files and non-generated line count}
**Execution**: {review groups, verifier count, pruned dimensions, missing coverage}

## PR readiness

| Area                 | Status                            | Evidence                                                   |
| -------------------- | --------------------------------- | ---------------------------------------------------------- |
| Code correctness     | pass / blocked / follow-up        | confirmed P0/P1/P2                                         |
| CI and authorization | pass / fail / pending             | current checks; identify external authorization separately |
| Conflicts            | clear / conflicting / unknown     | current mergeability                                       |
| Review threads       | clear / blocked                   | fully paginated unresolved current threads                 |
| Release readiness    | ready / checks required / blocked | package, native, migration, upgrade, benchmark evidence    |

**Recommendation**: {merge / do not merge yet / code is ready but wait for operational checks}

## Findings

### P0/P1/P2

1. `path/file.ts:42`: finding title
   - Severity/likelihood: P1, medium; blocks release: yes
   - Nature: introduced / legacy exposed by this change
   - User-visible scenario: ...
   - Evidence: ...
   - Fix direction: ...
   - Regression coverage: required / not required

## Pre-release checks

- [ ] Check: reason and whether it blocks release

## Process facts

- Objective workflow fact and evidence

## Needs more context

- Candidate: exact missing evidence

## Statistics

- Candidates / confirmed / false positives / need more context
- Confirmed by dimension and severity
```

Omit empty severity, pre-release, process, and context sections. When no issue survives independent
verification, write `No confirmed findings.` under Findings and still report coverage/statistics.

## Finding rules

- Put `path:line` before implementation detail so the reader has context.
- Write each finding self-contained so it converts directly into a `file-issue` invocation: the
  title, scenario, evidence, and fix direction map onto that skill's Problem, Diagnosis, and
  Proposed fix sections without needing this conversation. Offer follow-up filing for confirmed
  deferrable findings; never create issues during the review itself.
- Render only confirmed findings. Workflow facts are unverified by design and stay outside severity
  counts.
- Apply verifier overrides before rendering and merge same-root entries once.
- Every finding states severity, likelihood, release blocking, nature, concrete scenario, evidence,
  fix direction, and test need.
- Legacy bystander findings never block this change. A legacy bug newly triggered by the diff blocks
  only when the verified impact and severity justify it.
- Release checks are questions about real profiles/artifacts/environments, not defects. Never count
  them as findings.

## PR recommendation

Use the first applicable outcome:

1. Draft, merge conflict, failing required code check, confirmed release-blocking P0/P1, or current
   unresolved blocking review thread: `do not merge yet`.
2. Required checks pending, external authorization unresolved, or blocking package/native/upgrade
   evidence not run: `code is ready but wait for operational checks` when code findings are clean.
3. Otherwise: `merge`.

State code correctness, CI/authorization, conflicts, review threads, and release readiness
separately even when they lead to the same recommendation. A stale head invalidates the verdict.

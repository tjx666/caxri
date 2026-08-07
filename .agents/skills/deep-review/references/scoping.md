# Review Scope and Background

Select the exact change before reading implementation details. Record the target and, in PR mode,
the starting head SHA so the final report can prove it is current.

## 1. Classify the target

Use the first matching case:

1. A GitHub PR URL or explicit `PR #123`: use `gh pr diff <number>` and fetch current metadata with
   `gh pr view`.
2. A named commit or range: review exactly `git show <sha>` or `git diff <a>..<b>`; ignore unrelated
   worktree state.
3. Explicit uncommitted/current changes: use `git diff HEAD` plus every untracked file from
   `git ls-files --others --exclude-standard`.
4. A clean feature branch: fetch the remote default branch, sanity-check its commit set, then use
   `git diff origin/main...HEAD`.
5. A feature branch with uncommitted changes and no explicit scope: ask whether the target is the
   committed branch, uncommitted work, or both. The answers produce materially different reviews.

For a combined branch-plus-worktree review, diff the worktree against the merge base:

```bash
git diff "$(git merge-base origin/main HEAD)"
```

## 2. Range rules

- Branch diffs use three dots: `git diff origin/main...HEAD`.
- Sanity-check commits with two dots: `git log origin/main..HEAD --oneline`. Only the reviewed
  branch's commits should appear.
- Prefer `gh pr diff` in PR mode; it already uses the PR's real base/head pair.
- Do not include unrelated dirty files when the user named a commit, range, or PR.

## 3. Size before content

Probe with `--stat` first. Exclude bulk lockfile, snapshot, generated, `out/`, and `release/` content
from line-count sizing, while retaining the fact that those files changed. Review manifest or build
declarations that caused generated/lockfile changes.

- Small: at most 200 changed lines and 5 files. Inline the full diff in reviewer prompts.
- Large: pass exact read-only fetch commands and untracked paths to reviewers.
- Very large: over 1,500 non-generated lines. Split into cohesive behavioral scopes, review every
  scope, and consolidate the reports. Do not split only by directory when one behavior crosses
  processes.

Untracked files are part of the size and diff. For a small scope, include their full contents with
the path as a heading; for a large scope, instruct reviewers to open those exact files.

## 4. Establish background

Stop at the first source that states the requirement clearly:

1. Conversation context
2. Referenced GitHub issue via `gh issue view`
3. PR title/body and linked issue
4. Branch commit messages as a last resort

Summarize changed behavior, acceptance criteria, affected processes, and validation evidence in at
most 200 words. This summary is the reviewers' primary requirement yardstick.

## 5. PR state

Fetch at least:

```text
url, title, body, baseRefName, headRefName, headRefOid, files, commits,
mergeable, mergeStateStatus, isDraft, reviewDecision, statusCheckRollup
```

Use `gh api graphql` to fully paginate review threads. Record unresolved current threads separately
from resolved or outdated threads. Distinguish code failures from external authorization or
infrastructure failures.

Immediately before rendering the report, fetch `headRefOid` again. If it changed, discard stale
line evidence and rerun against the new head. After one repeated head change, stop and report that
the PR is moving too quickly for a current verdict.

## 6. Scope summary

Produce:

- `{changes}`: diff text or exact fetch commands and untracked paths
- `{scope_summary}`: at most 200 words
- `{review_head}`: commit/range or PR head SHA
- `{pr_state}`: PR metadata, checks, and review-thread summary when applicable

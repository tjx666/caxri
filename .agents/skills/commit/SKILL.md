---
name: commit
description: Create focused Git commits with GitHub-recognized semantic types, split large diffs by coherent intent, attach issue-closing keywords, and automatically push when the current branch already has an open pull request. Use when the user explicitly invokes `$commit` or asks to commit, submit, or check in the current changes.
---

# Commit

Turn the requested working-tree changes into reviewable commits without absorbing unrelated work.
Explicit invocation authorizes the commits and the conditional push described below. It does not
authorize force-pushing, creating a PR, or changing unrelated files.

## Inspect

1. Read `git status --short --branch`, `git diff --stat`, `git diff`, and `git diff --cached`
   before staging anything.
2. Identify the exact files and hunks belonging to the user's request. Preserve pre-existing or
   unrelated changes even when they share the worktree.
3. Check whether the current branch already has an open PR:

   ```bash
   gh pr view --json number,state,url,headRefName,baseRefName
   ```

   Record this before committing. Only an open PR for the current branch enables the automatic
   push step.

4. Identify any GitHub issue fully handled by the changes. Use the issue named in the request or
   conversation and verify uncertain references with `gh issue view`. Do not infer a closing issue
   from a coincidental number.

## Plan commits

Prefer one cohesive commit for one behavior. When the diff is large or spans independent concerns,
split it into commits that can each be reviewed and reverted on their own.

- Keep a bug fix and its regression test together.
- Keep a dependency manifest and its lockfile update together.
- Keep supporting documentation with the behavior it documents unless the documentation is an
  independent deliverable.
- Separate unrelated refactors, fixes, features, CI changes, and documentation.
- Do not create an intermediate commit that knowingly breaks the build or tests.
- Do not split mechanically by file count; split by intent and ownership boundary.

Stage explicit paths or hunks with `git add -- <paths...>` or `git add -p`. Never use a broad stage
command when it could capture unrelated work. After interactive staging, verify the intended hunk
actually entered the index; a wrapper may exit successfully without presenting a prompt. If it did
not, apply a reviewed patch with `git apply --cached`. Inspect `git diff --cached` before every commit.
For partially staged files, pause concurrent writers and isolate unstaged changes before running
commit hooks, which may restage whole files. Verify the committed tree before restoring those changes;
resolve any restore conflicts without discarding work. The hook's type-aware lint resolves imports
from disk, so a staged version that still imports a file the working tree renamed or deleted fails
with `no-unsafe-*` errors. Stage the rename together with its importers, or restore the old file
from `HEAD` for that commit and remove it afterwards.

The repository's `lint:staged` entry point must include `--no-stash`. All worktrees share Git's
stash stack, so commit hooks must not use lint-staged's default stash backup. Preserve partially
staged work with an explicit file copy and restore it after verifying the committed tree.

## Write messages

Write commit messages in English using a GitHub-recognized semantic type:

```text
type(optional-scope): imperative summary
```

Choose the narrowest applicable type:

| Type       | Use for                                     |
| ---------- | ------------------------------------------- |
| `feat`     | New user-visible behavior                   |
| `fix`      | Correctness or regression repairs           |
| `docs`     | Documentation-only changes                  |
| `refactor` | Structural changes without behavior changes |
| `test`     | Test-only changes                           |
| `perf`     | Performance improvements                    |
| `build`    | Build system or dependency changes          |
| `ci`       | CI workflow or runner changes               |
| `chore`    | Maintenance not covered by a narrower type  |
| `style`    | Formatting-only changes                     |
| `revert`   | Reverting an earlier commit                 |

Keep the summary concise, imperative, and without a trailing period. Use a body only when the
reason, trade-off, or issue link is not clear from the summary.

When a commit fully handles an issue, add a closing line to that commit message so GitHub closes
the issue after the commit reaches the default branch:

```text
fix: preserve terminal attachment state

Fix #123
```

Use `Fix owner/repository#123` for an issue in another repository. Repeat the keyword for every
issue (`Fix #123`, `Fix #456`). If the change only contributes to or references an issue without
fully handling it, use `Refs #123` instead of a closing keyword.

## Validate and commit

Call the Skill tool with "quality-check", then Call the Skill tool with "unit-testing" or
"e2e-testing" when that owning testing discipline applies to the changed files. Call the Skill tool
with "oss-confidentiality" after staging and review both the staged diff and proposed commit message
as public content. Then commit it. Repeat the stage, validate, confidentiality review, and commit
sequence for every planned commit. Never amend or rewrite existing commits unless the user
explicitly requests it.

Afterward, verify:

```bash
git status --short --branch
git log -n <commit-count> --oneline
```

Confirm that each requested change is committed and unrelated changes remain untouched.

## Push an existing PR branch

If the pre-commit PR check found an open PR for the current branch, resolve the current branch name
and push it explicitly after all commits and validations succeed:

```bash
git push origin HEAD:refs/heads/<current-branch>
```

Do not rely on the configured upstream: a task branch created from `origin/main` may retain that
base as its comparison upstream, and a plain `git push` would target or be blocked as a default-
branch push. Read back the branch/PR state and report the pushed commit SHA and PR URL.

If the branch had no open PR, do not push unless the user separately asked for a push. Never create
a PR implicitly, never force-push, and stop with the rejection details if a normal push fails.

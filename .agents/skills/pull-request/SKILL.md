---
name: pull-request
description: Create, update, validate, and merge Caxri pull requests against the latest default branch. Use when opening a PR, checking or repairing PR readiness, rebasing a topic branch for delivery, merging an authorized PR, or synchronizing the primary checkout after merge. Do not use for commit-only work with no PR operation.
---

# Pull Request

Deliver the current topic branch without weakening validation or disturbing unrelated local work.
Routing this skill for a readiness question is read-only and never grants remote mutation authority.

1. Refresh the current branch, working tree, remote refs, linked issue state, existing PR state, and
   required checks before making a delivery decision. Remote mutations require explicit user or
   owning-workflow authorization.
2. Require a clean working tree before rebasing; never rely on implicit autostash. Before opening a
   PR, fetch `origin/main` and verify the topic branch base. If `origin/main` has advanced, rebase onto
   the latest `origin/main`, resolve conflicts without discarding user changes, and rerun every
   validation invalidated by the rebase. Never open a PR from a knowingly stale base.
3. Push only when authorized. If rebasing rewrote an already published branch, refresh its remote
   object ID and verify no unincorporated remote commit exists. Update it only when the authorization
   covers the rewrite, using an exact `--force-with-lease=refs/heads/<branch>:<observed-oid>` lease;
   never use bare `--force`, and stop if the lease rejects the update.
4. Create or update the PR with an English title and body that describe
   observable behavior, validation, non-goals, and closing issue links. Read back the resulting PR.
5. Treat queued or failed required checks, unresolved conflicts, and active review findings as real
   readiness blockers. Repair the owning branch and refresh the exact-head state instead of merging
   stale evidence. Watch checks with `bun run scripts/watch-ci.ts [--run <id>]` in a background
   shell by default rather than ad-hoc
   polling loops: concurrent sessions (any worktree) share one GitHub poller, job failures notify
   immediately, and the watch survives offline windows.
6. Merge only when explicitly authorized by the user or an active workflow such as `go`. Verify the
   remote merged state and merge commit before reporting completion.
7. After a merge initiated from the primary checkout, return that checkout to `main` and fast-forward
   it to `origin/main`. Do this only when the working tree is clean and the update is fast-forward;
   otherwise preserve the checkout and report the exact dirty-state or divergence blocker.

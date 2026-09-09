---
name: pull-request
description: Create, update, validate, and merge Caxri pull requests against the latest default branch. Use when opening a PR, checking or repairing PR readiness, rebasing a topic branch for delivery, merging an authorized PR, or synchronizing the primary checkout after merge. Do not use for commit-only work with no PR operation.
---

# Pull Request

Deliver the current topic branch without weakening validation or disturbing unrelated local work.
Routing this skill for a readiness question is read-only and never grants remote mutation
authority.

When the user follows up on unfinished delivery by directing the agent to proceed with the
discussed merge, carry that authorization through commit, PR publication, checks, merge, and remote
readback. Do not end again at local validation or PR creation. A status-only question such as
"has it merged?" remains read-only and does not grant merge authorization.

1. Refresh the current branch, working tree, remote refs, linked issue state, existing PR state,
   and required checks before making a delivery decision. Remote mutations require explicit user or
   owning-workflow authorization.
2. Require a clean working tree before rebasing; never rely on implicit autostash. Before opening a
   PR, fetch `origin/main` and verify the topic branch base. If `origin/main` has advanced, rebase
   onto the latest `origin/main`, resolve conflicts without discarding user changes, and rerun every
   validation invalidated by the rebase. Never open a PR from a knowingly stale base.
3. Once required checks have started for a published PR head, routine `origin/main` advancement
   alone does not invalidate that evidence or require another rebase. When GitHub reports no
   conflict and branch protection does not require an up-to-date branch, let those checks finish
   and merge the validated head. Rebase a running or green head only for an actual conflict, an
   explicit freshness requirement, or concrete evidence that the integration changed semantics.
   Local ancestry alone is not a post-CI blocker.
4. Push only when authorized. If rebasing rewrote an already published branch, refresh its remote
   object ID and verify no unincorporated remote commit exists. Update it only when the
   authorization covers the rewrite, using an exact
   `--force-with-lease=refs/heads/<branch>:<observed-oid>` lease. Never use bare `--force`, and
   stop if the lease rejects the update.
5. Create or update the PR with an English title and body that describe observable behavior,
   validation, non-goals, and closing issue links. Read back the resulting PR.
6. Treat queued or failed required checks, unresolved conflicts, and active review findings as real
   readiness blockers. Repair the owning branch and refresh the exact-head state instead of merging
   stale evidence. Watch checks with `bun run scripts/watch-ci.ts --run <id>` using the
   harness-specific ownership rules in the reference below. Concurrent sessions, including other
   worktrees, share one GitHub poller
   through `~/.cache/caxri/ci-watch/`. Failed jobs raise an immediate macOS notification. Polling
   survives offline windows with capped backoff. The command exits 0/1 with the run conclusion.
   In Claude Code, execute the watcher in a background shell.
   In Codex, read and follow [Codex Watch Await](../../references/codex-watch-await.md)
   before starting or collecting the watcher.
7. Merge only when explicitly authorized by the user or an active workflow such as `go`. Verify the
   remote merged state and merge commit before reporting completion.
8. After the current task's PR is merged, inspect whether the task is running in the primary
   checkout or a linked worktree. In the primary checkout, normally switch back to `main` and
   fast-forward it to `origin/main`. In a linked worktree, leave its branch and checkout in place;
   do not switch it to `main`. Switch or update the primary checkout only when its working tree is
   clean and the update is fast-forward; otherwise preserve it and report the exact dirty-state or
   divergence blocker.

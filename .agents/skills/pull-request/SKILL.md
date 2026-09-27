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
   For an authorized multi-issue batch sharing one scarce CI runner, prefer one reviewable integration
   PR and one exact-head validation when the changes can be assessed together. Reassess an earlier
   per-issue PR plan when runner capacity becomes clear: preserve completed green checks, then
   consolidate the remaining branches and retire their duplicate queued runs and PRs after the
   integration PR is published. Keep unrelated contributors' PRs outside this consolidation.
2. Require a clean working tree before rebasing; never rely on implicit autostash. Before opening a
   PR, fetch `origin/main` and verify the topic branch base. If `origin/main` has advanced, rebase
   onto the latest `origin/main`, resolve conflicts without discarding user changes, and rerun every
   validation invalidated by the rebase. Never open a PR from a knowingly stale base.
   Before pushing Renderer React changes, run `bun run doctor:changed` against the intended diff
   and resolve every finding. The changed-file checker suggests this gate but does not run it;
   a green lint/type/knip result cannot substitute for the CI React Doctor gate.
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
   readiness blockers, unless the diff qualifies for [Fast merge without CI](#fast-merge-without-ci)
   or a failed case qualifies for the CI-only parity exception below.
   Repair the owning branch and refresh the exact-head state instead of merging
   stale evidence. Watch checks with `bun run scripts/watch-ci.ts --run <id>` using the
   harness-specific ownership rules in the reference below. Concurrent sessions, including other
   worktrees, share one GitHub poller
   through `~/.cache/caxri/ci-watch/`. Failed jobs raise an immediate macOS notification. Polling
   survives offline windows with capped backoff. The command exits 0/1 with the run conclusion.
   In Claude Code, execute the watcher in a background shell.
   In Codex, read and follow [Codex Watch Await](../../references/codex-watch-await.md)
   before starting or collecting the watcher.
   A single runner `offline` response is an availability snapshot, not proof that the machine
   is unreachable or requires owner intervention. Correlate it with this run's job history and
   subsequent runner status before diagnosing infrastructure failure. Keep following queued work
   through transient disconnects; do not mark the issue Blocked or end delivery solely because
   one status sample says offline. Inspect completed failed jobs even while the final gate queues.
   A failed unit, integration, or E2E case gets two local repetitions of the related cases — the
   failed cases plus, when they touch the changed behavior, the delivery's focused tests. Repairing
   CI never runs the local full unit or E2E suite (it occupies the user's machine; only the user's
   explicit request authorizes one) and never reruns CI repeatedly: checks share one self-hosted
   runner, so chasing an intermittent failure in place blocks this delivery and every sibling
   delivery behind it. When both repetitions pass, record the exact head, failed CI case/run, local commands/results, whether the case touches
   the changed behavior (a waived in-scope failure must say so explicitly),
   and waiver in the PR and the shared flaky-case tracker, then continue authorized delivery.
   Use the owning test runner; E2E reproduction and tracker publication follow
   [CI-only parity](../e2e-testing/SKILL.md#ci-only-parity).
   Do not require runner access or infrastructure root-cause diagnosis before applying this exception.
   Keep the failed CI result red, distinguish waived failures from checks that never ran, and never
   report the whole suite as passed. A failure that reproduces locally or lacks the two local passes
   remains a blocker unless the user explicitly authorizes a narrower exception.
   When every failure is waived but the failure aborted validation so some checks never ran, the
   merge decision stays with the agent; it is not a question for the user. Continue the authorized
   merge by default. If the never-run checks plausibly exercise the changed behavior, first hand the
   diff, the never-run list, and the waiver evidence to an independent reviewer (a subagent, or
   another harness through `dianjiang`), then adjudicate between merging and exactly one CI rerun,
   and record the verdict in the PR.
7. Merge only when explicitly authorized by the user or an active workflow such as `go`. Verify the
   remote merged state and merge commit before reporting completion.
8. After the current task's PR is merged, inspect whether the task is running in the primary
   checkout or a linked worktree. In the primary checkout, normally switch back to `main` and
   fast-forward it to `origin/main`. In a linked worktree, leave its branch and checkout in place;
   do not switch it to `main`. Switch or update the primary checkout only when its working tree is
   clean and the update is fast-forward; otherwise preserve it and report the exact dirty-state or
   divergence blocker.

## Fast merge without CI

One self-hosted runner serves every session, and a full pass costs 20-25 minutes of it. Spending
that on a diff CI cannot meaningfully judge starves every sibling delivery queued behind it. Two
narrow classes of change therefore skip CI once their own local gates pass:

- **Documentation only** — `docs/`, `AGENTS.md`, `.agents/**`, or another tracked `.md` that no
  shipped code reads. The owner has granted standing authorization: commit it directly on `main`
  in the primary checkout and push, with no worktree, branch, or pull request. If `main` moved,
  `git pull --ff-only` first and rerun the gates.
- **Renderer styling only** — token, spacing, color, or layout values with no behavior change,
  even when the change ships a test alongside them. It still goes through a pull request, which
  may merge without waiting for its checks.

Run the gates that actually cover the changed files first, and require them to pass:

| Changed                            | Local gates                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| Any `.md`                          | `bun run lint:markdown`, `bun run format:check`                                      |
| `.agents/skills/**` or `AGENTS.md` | plus `bunx vitest run scripts/__tests__/skill-invocation.test.ts`                    |
| Renderer styling                   | `bun run lint`, the change's own test, and the CDP visual check `AGENTS.md` requires |

A documentation diff is not automatically test-free: `skill-invocation.test.ts` asserts skill
frontmatter, the `.claude/skills` symlink, the explicit-only invocation list, and how skills may
reference one another, so prose edited here can fail a unit test no markdown linter would catch.

One line outside those classes disqualifies the exception. A diff that also touches `apps/`,
`packages/`, `extensions/`, `e2e/`, `scripts/`, `tools/`, a workflow YAML, `package.json`, or
`pnpm-lock.yaml` returns to the normal path — documentation bundled with a code change is a code
change. For Renderer styling, the exception removes the wait, not the merge authorization step 7
still requires.

Merging does not stop the PR's run, and a documentation push to `main` may start one — a queued job
keeps its place in line and will still take the runner for a head nobody is waiting on. Cancel it
explicitly:

```bash
gh api -X POST repos/tjx666/caxri/actions/runs/<run-id>/cancel
```

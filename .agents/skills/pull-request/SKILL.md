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
"has it merged?" does not grant new merge authorization or revoke an existing authorized delivery.
After answering an intervening question, resume that delivery using the existing watcher result:
a failed run requires diagnosis and repair, not just a status reply. Stop only when the user pauses
or cancels the delivery, or a concrete blocker requires their input.

1. Refresh the current branch, working tree, remote refs, linked issue state, existing PR state,
   and required checks before making a delivery decision. Remote mutations require explicit user or
   owning-workflow authorization.
   For an authorized multi-issue batch, prefer one reviewable integration PR and one exact-head
   validation when the changes can be assessed together. Reassess an earlier per-issue PR plan when
   the work proves to be one delivery: preserve completed green checks, then consolidate the
   remaining branches and retire their duplicate queued runs and PRs after the integration PR is
   published. Keep unrelated contributors' PRs outside this consolidation.
2. Require a clean working tree before rebasing; never rely on implicit autostash. Before opening a
   PR, fetch `origin/main` and verify the topic branch base. If `origin/main` has advanced, rebase
   onto the latest `origin/main`, resolve conflicts without discarding user changes, and rerun every
   validation invalidated by the rebase. Never open a PR from a knowingly stale base.
   `git rebase --continue` commits without the pre-commit hook, so a conflict resolution never gets
   lint-staged's Prettier pass: run `bun run format:check` before pushing a rebased branch, since
   CI's `format:check` fails on one unformatted line in an otherwise green diff.
   Before pushing Renderer React changes, run `bun run doctor:changed` against the intended diff
   and resolve every finding. The changed-file checker suggests this gate but does not run it;
   a green lint/type/knip result cannot substitute for the CI React Doctor gate.
   Before pushing any TypeScript change, run `bun run knip` against the intended diff and resolve
   every finding. CI runs knip only in the `full` checks scope (a main push, an explicit dispatch,
   or a ready PR that touches a full-validation path); the `affected`, `focused-*`, and draft scopes
   skip it, and the changed-file checker runs knip only when `--knip` is passed. An unused export
   that skips the local run can therefore merge and surface only on the hosted main-push checks.
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
   validation, non-goals, and closing issue links. A ready PR records affected E2E but never starts
   the full suite automatically, and the import graph cannot see which Electron workflows a
   Renderer or Server change reaches: when the change is user-visible, add one
   `CI-E2E-Tests: ["e2e/example.e2e.ts"]` line naming the specs that cover it (see
   `docs/ci-performance.md`). Set it before pushing, since the policy reads the body at push time.
   Run `bun run scripts/surface-matrix.ts` against the pushed diff (`--base origin/main` is the
   default) and paste its Markdown output into the PR body. It reports which product surfaces the
   diff touches (Desktop main/preload/Renderer, Server, Terminal Host, Extension Host, CLI,
   Mobile, protocol contracts, extensions, e2e, docs, contributor skills, CI), and the proof this
   repository already requires for each one, plus a reverse-state reminder for a diff that adds a
   one-way user action. Before the PR is ready, resolve every listed proof row to `done` or
   `waived: <reason>`; a row left `PENDING` is unproven, not passing. Use `--json` when scripting
   the body instead of reading it by eye. Read back the resulting PR.
6. Treat queued or failed required checks, unresolved conflicts, unresolved surface-matrix proof
   rows, and active review findings as real readiness blockers, unless the diff qualifies for
   [Fast merge without CI](#fast-merge-without-ci) or a failed case qualifies for the CI-only parity
   exception below.
   Repair the owning branch and refresh the exact-head state instead of merging
   stale evidence. Watch checks with `bun run scripts/watch-ci.ts --run <id>` using the
   harness-specific ownership rules in the reference below. Concurrent sessions, including other
   worktrees, share one GitHub poller
   through `~/.cache/caxri/ci-watch/`. A watcher reports the run attempt it was watching, so start a
   new one after `gh run rerun`. Failed jobs raise an immediate macOS notification. Polling
   survives offline windows with capped backoff. The command exits 0/1 with the run conclusion.
   In Claude Code, execute the watcher in a background shell. Redirect its output to a run-specific
   path such as `/tmp/watch-ci-<run-id>.log`, never a generic name like `/tmp/watch-ci.log`:
   sibling sessions write their own watchers there too, and an overwritten log reports another
   PR's run as yours.
   In Codex, read and follow [Codex Watch Await](../../references/codex-watch-await.md)
   before starting or collecting the watcher.
   A queued hosted job is a waiting state, not proof of repository infrastructure failure or a
   reason to request access to a maintainer machine. Correlate it with this run's job history and
   subsequent status before diagnosing infrastructure failure. Keep following queued work through
   transient service delays, and inspect completed failed jobs while another gate remains queued.
   A failed unit, integration, or E2E case gets two local repetitions of the related cases: the
   failed cases plus, when they touch the changed behavior, the delivery's focused tests. Repairing
   CI never runs the local full unit or E2E suite (it occupies the user's machine; only the user's
   explicit request authorizes one) and never reruns CI repeatedly: repair the demonstrated cause
   locally before spending another disposable hosted run. When both repetitions pass, record the
   exact head, failed CI case/run, local commands/results, whether the case touches
   the changed behavior (a waived in-scope failure must say so explicitly),
   and waiver in the PR and the shared flaky-case tracker, then continue authorized delivery.
   Use the owning test runner; E2E reproduction and tracker publication follow
   [CI-only parity](../e2e-testing/SKILL.md#ci-only-parity).
   Do not require runner access or infrastructure root-cause diagnosis before applying this exception.
   A failure that only a hosted runner produces (a download timeout or missing cold-environment
   toolchain) is diagnosed from that job's logs and the pinned runner-image contract. Do not replace
   missing hosted evidence with SSH access or an unrequested local full-suite run.
   Keep the failed CI result red, distinguish waived failures from checks that never ran, and never
   report the whole suite as passed. A failure that reproduces locally or lacks the two local passes
   remains a blocker unless the user explicitly authorizes a narrower exception.
   Before treating a locally reproduced failure as the branch's, run the same command twice on
   `origin/main`. If main fails identically (for example the Renderer performance gate reporting
   `primary-sidebar.profiledRenderCount` 5 against a baseline of 4 on both), it is a pre-existing
   main failure: record both sides' results in the PR, file or link the issue that owns the main
   regression, and continue the authorized merge. A failure absent on main stays a blocker.
   When every failure is waived but the failure aborted validation so some checks never ran, the
   merge decision stays with the agent; it is not a question for the user. Continue the authorized
   merge by default. If the never-run checks plausibly exercise the changed behavior, first hand the
   diff, the never-run list, and the waiver evidence to an independent reviewer (a subagent, or
   another harness through `dianjiang`), then adjudicate between merging and exactly one CI rerun,
   and record the verdict in the PR.
7. Merge only when explicitly authorized by the user or an active workflow such as `go`. When a run
   has finished, gate the merge on its `conclusion` read explicitly in the same command
   (`gh api repos/<owner>/<repo>/actions/runs/<id> --jq .conclusion` equals `success`) or on a
   recorded waiver. Never pipe the watcher into `tail` and trust the exit status: without
   `pipefail` it is `tail`'s, and a red run once merged that way. Verify the remote merged state
   and merge commit before reporting completion.
8. After the current task's PR is merged, inspect whether the task is running in the primary
   checkout or a linked worktree. In the primary checkout, normally switch back to `main` and
   fast-forward it to `origin/main`. In a linked worktree, leave its branch and checkout in place;
   do not switch it to `main`. Switch or update the primary checkout only when its working tree is
   clean and the update is fast-forward; otherwise preserve it and report the exact dirty-state or
   divergence blocker.

## Fast merge without CI

`main` requires the `guards` status check (gitleaks, `docs-check`, `source-size-ratchet` on a
GitHub-hosted runner, see [ADR 0016](../../../docs/adr/0016-github-hosted-ci.md)) to pass
before anything merges, and that requirement applies with no bypass: a raw `git push` to `main` is
rejected outright, so every change, including a one-line documentation fix, goes through a pull
request. What "fast merge" skips is the separate non-required hosted `checks` job; full E2E never
starts automatically. Until branch protection adopts that hosted result as required, the owner
continues to allow these three classes to merge after their own local gates and `guards` pass:

- **Documentation only**: `docs/`, `AGENTS.md`, Markdown and skill `agents/openai.yaml` metadata
  under `.agents/`, or another tracked `.md` that no shipped code reads. Scripts under `.agents/`,
  such as `.agents/skills/switch-worktree/scripts/worktree-processes.ts`, are code and take the
  third class's gates. Open a pull request from a branch (no separate worktree needed for a
  documentation-only diff) and merge it as soon as `guards` reports success, without waiting for
  `checks`/`e2e`.
- **Renderer styling only**: token, spacing, color, or layout values with no behavior change,
  even when the change ships a test alongside them. Same as above: open the pull request and merge
  once `guards` passes.
- **Locally verified code change**: any other diff whose PR `CI-E2E-Tests` specs pass locally
  and, for a user-visible change, whose behavior was accepted over CDP. The owner allows the PR to
  merge once `guards` passes, without waiting for the non-required hosted `checks` result. A hosted
  `checks` run that already finished red still blocks unless step 6 waived it; `guards` itself never
  gets waived; its failure means fix the diff, not merge around it.

Run the gates that actually cover the changed files first, and require them to pass:

| Changed                            | Local gates                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| Any `.md`                          | `bun run lint:markdown`, `bun run format:check`                                      |
| `.agents/skills/**` or `AGENTS.md` | plus `bunx vitest run scripts/__tests__/skill-invocation.test.ts`                    |
| Renderer styling                   | `bun run lint`, the change's own test, and the CDP visual check `AGENTS.md` requires |
| Locally verified code change       | `check --lint --test --type --knip`, the `CI-E2E-Tests` specs, and the CDP check     |

A documentation diff is not automatically test-free: `skill-invocation.test.ts` asserts skill
frontmatter, the `.claude/skills` symlink, the explicit-only invocation list, and how skills may
reference one another, so prose edited here can fail a unit test no markdown linter would catch.

One line outside the first two classes disqualifies them. A diff that also touches `apps/`,
`packages/`, `extensions/`, `e2e/`, `scripts/`, `tools/`, a workflow YAML, `package.json`, or
`pnpm-lock.yaml` returns to the normal path; documentation bundled with a code change is a code
change and needs the third class's gates. For a PR, the exception removes the wait, not the merge
authorization step 7 still requires.

Merging does not stop the PR's hosted run, and the merge starts a separate hosted main-push check.
Keep both as evidence unless a replacement head makes one obsolete; cancel only that exact obsolete
run under the delivery's existing Actions authority.

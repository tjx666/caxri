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
   lint-staged's formatter pass: run `bun run format:check` before pushing a rebased branch, since
   CI's `format:check` fails on one unformatted line in an otherwise green diff.
   Before pushing React changes in Desktop's Renderer or in `apps/mobile`, run
   `bun run doctor:changed` against the intended diff and resolve every finding. The changed-file
   checker suggests this gate but does not run it; a green lint/type/knip result cannot substitute
   for the CI React Doctor gate, which also scans Mobile.
   Before pushing any TypeScript change, run `bun run knip` against the intended diff and resolve
   every finding. CI runs knip in the `full` checks scope (a main push, an explicit dispatch, or a
   ready PR that touches a full-validation path) and in the `affected` scope of an ordinary ready
   source PR; the `focused-*` and draft scopes skip it, and the changed-file checker runs knip only
   when `--knip` is passed. An unused export in a draft or focused-scope PR can therefore still
   surface only on the hosted main-push checks.
   Before pushing a rebased branch or a diff that changes `@types/*` or another type-declaration
   dependency, run `bun run lint:type-aware` and resolve every finding. The changed-file checker
   never runs oxlint's type-aware rules, and CI's full platform checks stop at their first finding:
   moving `@types/node` from 26 to 24 turned an exit listener's parameters into `any` in
   `scripts/exec.ts`, and a test added on `main` still used a field the branch had renamed.
3. Once required checks have started for a published PR head, routine `origin/main` advancement
   alone does not invalidate that evidence or require another rebase. When GitHub reports no
   conflict and branch protection does not require an up-to-date branch, let those checks finish
   and merge the validated head. Rebase a running or green head only for an actual conflict, an
   explicit freshness requirement, or concrete evidence that the integration changed semantics.
   Local ancestry alone is not a post-CI blocker.
4. Before the first push, Call the Skill tool with "oss-confidentiality" and review the diff,
   commits, branch name, and intended public artifacts. Push only when authorized. If rebasing
   rewrote an already published branch, refresh its remote object ID and verify no unincorporated
   remote commit exists. Update it only when the authorization covers the rewrite, using an exact
   `--force-with-lease=refs/heads/<branch>:<observed-oid>` lease. Never use bare `--force`, and
   stop if the lease rejects the update.
   For an ordinary non-force push from a linked worktree, make the destination auditable with
   `git push origin HEAD:refs/heads/<branch>` instead of a bare `git push`; the repository's
   default-branch guard cannot safely infer the target of an abbreviated command.
   Create the PR only after that push exits 0 and `git ls-remote origin refs/heads/<branch>` equals
   the local `HEAD`: a push rejected against a stale same-named remote branch, followed by
   `gh pr create` after a `;`, opened a PR showing five unrelated months-old commits.
5. Create or update the PR with an English title and body that describe observable behavior,
   validation, non-goals, and closing issue links. A ready PR records affected E2E but never starts
   the full suite automatically, and the import graph cannot see which Electron workflows a
   Renderer or Server change reaches: when the change is user-visible, add one
   `CI-E2E-Tests: ["e2e/example.e2e.ts"]` line naming the specs that cover it (see
   `docs/ci-performance.md`). CI reads the body from the `pull_request` event that starts a run
   (`opened`, `synchronize`, `ready_for_review`, and the like), and editing the body starts none: put the line in the body passed
   to `gh pr create`, and update it before a later push, not after. A ready PR only records these
   specs (`runE2E: false`); a skipped `e2e` job is expected, so run them locally.
   Write every `--body-file` to a fresh quoted `mktemp` file and remove it after use; never a
   fixed path such as `/tmp/pr-body.md`, which two parallel sessions overwrote into each other's PR
   body. A per-PR-number name still does not isolate concurrent updates of the same PR.
   A shared UI primitive that changes locator attributes or overlay opening or pointer behavior
   (`title` becoming the shared Tooltip; a focus tooltip now intercepting a right-click) reaches
   every caller: trace them into `e2e/`, search obsolete locators (`getByTitle`) and the affected
   interactions, and list and locally run every affected spec in `CI-E2E-Tests`. The Tooltip
   refactor broke `file-operations.e2e.ts` on `main`.
   A diff that rewrites user-visible text or removes or renames a control also breaks specs that
   assert the old text or accessible name, and nothing selects them: search `e2e/` for each old
   string, then list and run every match. Rewording the return hint to "since you left" left
   `session-return-context.e2e.ts` asserting "since you last looked" on `main`. A diff that changes
   how existing content renders (a path becoming a pill, a long message clamped behind "Show more")
   breaks text assertions the same way: search `e2e/` for specs reading that content and run them.
   Rendering sent paths as pills left `agent-chat-handoff.e2e.ts` matching the full path on `main`.
   A change to a shared fixture under `e2e/support/` (profile defaults, launch helpers) reaches
   every spec that relies on what it changed: search `e2e/` for specs reading that value or helper
   and list them too. Changing `e2e/support/e2e-profile.ts` defaults while listing only
   `editor-auto-save.e2e.ts` left `settings.e2e.ts` failing on `main`.
   The same holds for the shared fake Agents under `apps/server/src/domains/agent-chat/__tests__/fixtures/`
   and their helper modules, which the import graph never links to a spec: when a message or
   command's handling changes, search `e2e/` for specs sending it, list them, and run each complete
   spec without `--e2e-grep`. Teaching the fake Claude Code to run `/goal` broke a sibling case in
   `agent-chat-goal.e2e.ts` that a grep-narrowed run of the new case skipped.
   A diff that changes a default keybinding or what a key does in a surface breaks specs that
   press that key for the old meaning: search `e2e/` for `press('<key>')` (with and without
   modifiers, such as `'Enter'` and `'Meta+Enter'`) and list every spec it reaches. Making plain
   Enter steer a running Chat turn (#2610) left `session-return-context.e2e.ts` failing on `main`.
   Run `bun run scripts/surface-matrix.ts` against the pushed diff (`--base origin/main` is the
   default) and paste its Markdown output into the PR body. It reports which product surfaces the
   diff touches (Desktop main/preload/Renderer, Server, Terminal Host, Extension Host, CLI,
   Mobile, protocol contracts, extensions, e2e, docs, contributor skills, CI), and the proof this
   repository already requires for each one, plus a reverse-state reminder for a diff that adds a
   one-way user action. Before the PR is ready, resolve every listed proof row to `done` or
   `waived: <reason>`; a row left `PENDING` is unproven, not passing. Use `--json` when scripting
   the body instead of reading it by eye. After the final PR title and body are assembled but before
   creating or updating the PR, Call the Skill tool with "oss-confidentiality" and review that
   metadata, its links, and its referenced artifacts as public content. For every embedded,
   attached, or linked image, the acting Agent must complete that skill's original-and-final visual
   review; do not create or update the PR until each image is confirmed safe or removed, and never
   hand routine screenshot review to the maintainer. Read back the resulting PR.
   GitHub ignores negation around a closing keyword: "This PR does not close #2574" closed #2574
   on merge. Mention an issue that must stay open without a `close`/`fix`/`resolve` verb before
   its number ("#2574 stays open"), and confirm `gh pr view --json closingIssuesReferences` lists
   exactly the issues the PR should close.
6. Treat queued or failed required checks, unresolved conflicts, unresolved surface-matrix proof
   rows, and active review findings as real readiness blockers, unless the diff qualifies for
   [Fast merge without CI](#fast-merge-without-ci) or a failed case qualifies for the CI-only parity
   exception below.
   Repair the owning branch and refresh the exact-head state instead of merging
   stale evidence. Right after a push, watch checks with `bun run scripts/watch-ci.ts --pr <number>`
   using the harness-specific ownership rules in the reference below: it waits for the new head's
   runs, watches every workflow, and fails at once when the PR conflicts with its base, which starts
   no CI. A diff that qualifies for [Fast merge without CI](#fast-merge-without-ci) adds
   `--workflow Guards`, so the watcher returns as soon as the required check does instead of
   waiting on the slower `checks` job. Use `--run <id>` for a single known run. After a merge,
   `--sha <merge commit>` (full or short) follows every run of that commit, including a
   `workflow_run` downstream such as the Release macOS run, and prints which run failed. After
   merging a code PR, run `bun run scripts/watch-ci.ts --sha <merge-sha>` (without
   `--workflow Guards`) and adjudicate its result before declaring delivery complete: individually
   green PRs merged minutes apart left `main` red when a call added in one missed a parameter the
   other made required. A `main` run that a newer push cancelled proves nothing either way:
   `--sha` follows the newer run that contains the merge, and only that run's success verifies
   it. When every successor it follows is cancelled too, the merge is still unverified, not
   failed: watch the next `main` run that contains it. Concurrent sessions, including other
   worktrees, share one GitHub poller
   through `~/.cache/caxri/ci-watch/`. A watcher reports the run attempt it was watching, so start a
   new one after `gh run rerun`. Failed jobs raise an immediate macOS notification. Polling
   survives offline windows with capped backoff. The command exits 0 only when every watched run
   succeeded.
   In Claude Code, execute the watcher in a background shell. Redirect its output to a run-specific
   path such as `/tmp/watch-ci-<run-id>.log` or `/tmp/watch-ci-pr-<number>.log`, never a generic name like `/tmp/watch-ci.log`:
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
   and waiver in the PR and in that case's own flaky-test issue, then continue authorized delivery.
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
7. Merge only when explicitly authorized by the user or an active workflow such as `switch-worktree`'s delivery flow. When a run
   has finished, gate the merge on its `conclusion` read explicitly in the same command
   (`gh api repos/<owner>/<repo>/actions/runs/<id> --jq .conclusion` equals `success`) or on a
   recorded waiver. Never pipe the watcher into `tail` and trust the exit status: without
   `pipefail` it is `tail`'s, and a red run once merged that way. Verify the remote merged state
   and merge commit before reporting completion. For a code PR, completion also needs the
   post-merge `watch-ci.ts --sha <merge-sha>` result from step 6.
8. After the current task's PR is merged, inspect whether the task is running in the primary
   checkout or a linked worktree. In the primary checkout, normally switch back to `main` and
   fast-forward it to `origin/main`. In a linked worktree, leave its branch and checkout in place;
   do not switch it to `main`. Switch or update the primary checkout only when its working tree is
   clean and the update is fast-forward; otherwise preserve it and report the exact dirty-state or
   divergence blocker.
9. In the report that closes the delivery after the merge, add a workflow-improvement section
   without being asked. List each friction this delivery actually hit that a script, guard, CI
   route, lint rule, or agent-file change could prevent: the symptom, the evidence, and the owning
   file to change. For example, a hook merged with a green focused check and then turned `main`'s
   full suite red because no selector routed its directory to the test that scans it. Say plainly
   when nothing qualified; do not pad the list. Before listing an item, fetch `origin/main` and
   check the commits merged since the branch's base, plus open issues and PRs, for the owning file
   or symptom: parallel sessions merge constantly, so a suggested guard may already exist on `main`.
   Drop an item that is already fixed and link the tracker for one that is already filed. Then hand
   the surviving items, with their evidence, to Codex through `dianjiang` (`second-opinion`,
   read-only) to verify each against the code and existing skills before reporting; report its
   verdict per item. For example, a proposed `drive-app.ts` seeding step can turn out to be
   covered by an existing `CAXRI_TEST_ROOT_PATHS` fixture the owning skill never mentions. Applying
   a suggestion follows `AGENTS.md`'s workflow-improvement rule.

## Fast merge without CI

`main` requires the `guards` status check (gitleaks, `docs-check`, `source-size-ratchet`, `em-dash-check`, and the directory-density ratchet test on a
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
  gets waived; its failure means fix the diff, not merge around it. A diff that widens what a lint
  rule or `check --lint` reaches (a new rule, a new path scope, sibling linting) leaves this class:
  run `bun run lint --no-cache` or wait for the hosted full lint, since focused checks cannot see
  existing violations elsewhere (sibling linting merged while `features/settings` still broke
  `caxri/feature-directory-structure`, failing `checks` for every later PR there).

Run the gates that actually cover the changed files first, and require them to pass:

| Changed                            | Local gates                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| Any `.md`                          | `bun run lint:markdown`, `bun run format:check`                                      |
| `.agents/skills/**` or `AGENTS.md` | plus `bunx vitest run scripts/__tests__/skill-invocation.test.ts`                    |
| A skill's `SKILL.md`               | plus `bun run --silent check <changed SKILL.md paths> --test`                        |
| Renderer styling                   | `bun run lint`, the change's own test, and the CDP visual check `AGENTS.md` requires |
| Locally verified code change       | `check --lint --test --type --knip --related` (below), `CI-E2E-Tests`, CDP           |

Some skill tests read their `SKILL.md` as data, and `check --test` selects every test of the skill
owning a changed `SKILL.md`: `label-axes.test.ts` compares the `file-issue` label tables against a
fixed list, so a Markdown-only label addition that skipped it merged and turned `checks` red for
later unrelated pull requests.

`check --test` otherwise selects only tests that import a changed file directly, so a test reaching it through
another module is skipped: `status-merge.test.ts` imports `status-tree.ts`, which reaches
`status-agent-actions.ts`, and a stale assertion there merged under this class and turned `main`'s
hosted `checks` red. Before a fast merge of a code change, also pass `--related`, which runs every
transitive importer of the changed sources (a 44-file Renderer and Mobile diff selected 325 test
files and ran in about two minutes). When the diff touches `package.json`, a Vitest config, or a
module nearly every suite imports, skip this class and wait for the hosted `checks` result instead
of running the full suite locally: one changed `packages/protocol` source selected 1127 test files
and ran for about seven minutes.

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

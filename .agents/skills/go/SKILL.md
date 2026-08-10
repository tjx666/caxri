---
name: go
description: >
  Manual-only Caxri delivery orchestration for turning one or many requirements
  into a continuously executing Codex Goal. Use only when the user explicitly
  invokes `$go`, `/go`, or asks to run the project Go workflow. It triages and
  deduplicates requirements, resolves material decisions before starting,
  creates GitHub issues, executes each issue through implementation, focused
  validation, light review and commit, performs a final deep review, opens and
  repairs a PR, runs macOS Electron Acceptance rounds, merges, closes issues,
  and reports technical debt and workflow improvements. Do not trigger on an
  ordinary conversational "go ahead" or a single routine edit.
---

# Go

Run a durable, autonomous multi-issue delivery loop. Keep the Goal active from
the moment execution begins until the accepted PR is merged, issue state is
verified, and the execution report is complete.

Explicit invocation authorizes the in-scope local and remote workflow described
here: create or update GitHub issues, edit and validate code, create commits,
push the working branch, create and update a PR, publish LobeHub Acceptance
rounds, merge an accepted PR, close its issues, and directly repair narrow
project-local `AGENTS.md`, skill, or Acceptance-adapter defects discovered by
the run. It does not authorize unrelated work, destructive data operations,
secrets, account changes, releases, or an unapproved expansion of the business
goal.

## Durable state

Initialize a run ledger before remote mutations:

```bash
bun run .agents/skills/go/scripts/state.ts init --objective "<business goal>"
```

Store the printed path and update it after every phase, issue, PR, Acceptance,
or durable observation. Read [references/state.md](references/state.md) before
using the state script. Treat GitHub and LobeHub as authoritative remote state;
the ledger is the compact resume index that prevents repeated discovery after
context compaction. Resume with the ledger's compact `resume --json` command;
do not reload the full event history unless an audit needs it. Record workflow
observations in Simplified Chinese because they are surfaced at the Acceptance
handoff.

## Phase 0: admit work before starting the Goal

Read [references/intake.md](references/intake.md) in full.

1. Refresh the working tree, current branch, open issues, related PRs, and
   authentication state without modifying them.
2. Normalize the user's requirements. Deduplicate them and classify each as
   execute now, already satisfied, defer, reject, or discuss before execution.
3. Resolve every material product choice, scope expansion, external authority,
   destructive action, or unavailable prerequisite now. Do not knowingly carry
   an ordinary decision gate into the active Goal.
4. Split selected work into independently verifiable GitHub issues. Reuse an
   existing issue when it already owns the work; otherwise invoke the
   repository's `file-issue` skill.
5. Freeze dependencies, priorities, execution order, issue completion criteria,
   and stable Acceptance check ids. Produce one compact execution plan.
6. Initialize the ledger. When the runtime provides `create_goal`, call it with
   the concrete objective and do not set a token budget unless the user explicitly
   requested one. In a compatible client without that tool, transition the ledger
   to active execution and use it as the durable Goal marker; do not pause or
   pretend a missing tool call succeeded.

Once the Goal starts, continue autonomously through routine repairs, restarts,
reviews, commits, remote checks, and Acceptance rounds. A wait for CI or human
Acceptance is an active workflow state, not a completed or blocked Goal.

## Phase 1: execute each issue

For each queued issue in dependency order:

1. Refresh the issue and mark it `progressing` in the run ledger and the owning
   remote workflow when one exists.
2. Reconfirm the current source and the issue's observable completion criteria.
3. For a reproducible bug, add or identify the failing behavior regression
   before fixing it. Finish source edits before updating tests when project
   instructions require that order.
4. Implement the smallest cohesive solution and run only affected validation.
5. Invoke `deep-review` in light mode for the issue's current diff.
6. Repair every valid blocking finding and repeat focused validation plus light
   review until clear.
7. Create one cohesive English commit. Record the commit, validation, and stable
   Acceptance ids in the ledger. Continue immediately to the next issue.

Do not capture final Acceptance evidence yet; later cross-issue repairs can make
it stale.

## Phase 2: deep review and PR delivery

After all issue commits:

1. Invoke the repository's `deep-review` skill in full deep mode over the whole
   Goal range.
2. Repair findings, run affected validation, commit, and repeat the deep review
   whenever a repair crosses issue or architectural boundaries.
3. Push the branch and create a PR whose body maps issues to behavior and uses
   closing keywords for issues that should close on merge.
4. Recheck that the actual PR diff is exactly covered by the frozen Goal and its
   Acceptance matrix. A narrow Acceptance must never certify a broader PR.
5. Monitor CI, conflicts, review threads, and required checks. Do not busy poll.
6. Route code failures through repair, focused validation, light review, commit,
   and push. A zero-step hosted-runner billing or infrastructure failure remains
   external and blocked. Admit the documented local fallback only after the user
   separately authorizes it; record exact-head evidence before running the exact
   platform-neutral gates and one full isolated Electron E2E suite. Never call
   the hosted check green.

Read [references/workflow.md](references/workflow.md) for the transition table
and repair routing.

## Phase 3: Acceptance loop

After the PR head is review-clean and either its required checks are green or an
exact-head local fallback has passed, invoke the project-local `acceptance`
skill. Its only product surface is isolated macOS Electron desktop.

Read [references/acceptance-loop.md](references/acceptance-loop.md) before the
first round. The Go intake plan already authorizes the planned Acceptance cases;
do not add another routine confirmation gate.

- Publish failures discovered after round execution starts; never silently fix
  and erase the failed snapshot.
- Route in-scope product failures back to their issue, repair, review, commit,
  push, and a new immutable round.
- Route evidence, adapter, fixture, or report failures to verification repair,
  not product code.
- File unrelated discoveries as follow-up issues and continue only when they do
  not weaken the accepted business requirement.
- After a passing round, transition to `waiting_acceptance` while keeping the
  Goal active. Run the compact ledger resume command and include up to three
  material workflow observations collected so far with the stable Acceptance
  URL. Keep the complete technical-debt, workflow-evolution, and token-efficiency
  audit for the post-merge report. Then yield control to the user.
  Do not start a same-turn polling loop or emit periodic pending updates. Query
  status once only after a later user or automatic continuation; never rerun
  code or tests merely because review is pending.
- Never accept or reject the builder's own delivery.

On human rejection, fetch actionable feedback, reuse stable check ids, omit
accepted checks unless at risk, transition back through `acceptance` to
`issue_execution` or `deep_review`, repair, and publish the next round. On human
acceptance, proceed to merge. Any code change needed to merge invalidates the
accepted head and requires review plus another Acceptance round.

## Phase 4: merge, close, and learn

1. Merge the accepted PR and verify its remote merged SHA.
2. Verify every intended issue is closed. Close an authorized issue directly
   only when merge automation did not.
3. Refresh all remote state before reporting it.
4. Read [references/report.md](references/report.md). Produce the execution
   report with delivery results, Acceptance history, technical debt, workflow
   improvements, and token-efficiency findings.
5. Apply obvious, narrow project-local workflow fixes when discovered early
   enough to remain inside the reviewed PR. Never mutate the active skill to
   change the current run's rules, recursively run self-improvement, or append
   literal feedback as permanent policy.
6. Create follow-up issues for durable product debt. Keep larger or generic
   workflow proposals in the report or route them upstream.
7. Mark the Goal complete only after no required work remains. When the Goal has
   a token budget, report final usage returned by the Goal tool.

## Non-negotiable invariants

- Keep at most one issue actively progressing unless independent parallel work
  was explicitly authorized and the applicable skill requires it.
- Preserve user changes and unrelated dirty worktree state.
- Never treat passing tests, code review, PR merge, deployment, and Acceptance
  as interchangeable facts.
- Never run the full local Electron E2E suite during an ordinary run. The only
  exception is the user-authorized, exact-head, ledger-recorded external CI
  fallback defined by the `test` skill and Go workflow reference.
- Never expose local report paths or internal verification-run URLs in the final
  handoff; expose the stable Acceptance URL.
- Never mark a Goal blocked merely because CI or human Acceptance is pending.

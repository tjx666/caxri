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
handoff. Add a deduplicated `token_waste` or `workflow` note as soon as a costly
repeat or stable script candidate is observed; do not reconstruct the audit by
rereading the transcript at the end.

## Phase 0: admit work before starting the Goal

Read [references/intake.md](references/intake.md) in full.

1. Refresh the working tree, current branch, open issues, related PRs, and
   authentication state without modifying them.
2. Normalize the user's requirements. Deduplicate them and classify each as
   execute now, already satisfied, defer, reject, or discuss before execution.
3. Invoke the `competitors` skill before proposing issue solutions. Use current
   source evidence from relevant products, prefer VS Code for performance,
   security, filesystem, editor, IPC, and desktop-platform mechanics, and prefer
   Orca, Muxy, Kero, or another close workbench for UI and UX behavior.
4. Resolve every material product choice, scope expansion, external authority,
   destructive action, or unavailable prerequisite now. Do not knowingly carry
   an ordinary decision gate into the active Goal.
5. Split selected work into independently verifiable GitHub issues. Reuse an
   existing issue when it already owns the work; otherwise invoke the
   repository's `file-issue` skill. Every admitted issue must contain explicit
   `UX 设计` and `Acceptance 方案` sections, including a reason when no direct UI
   claim exists.
6. Freeze dependencies, priorities, execution order, issue completion criteria,
   UX decisions, stable Acceptance check ids, and the issue-level Acceptance
   coverage contract. Do not pre-author the final case execution plan; a fresh
   tester subagent derives it from the stable delivered head. Produce one compact
   execution plan.
7. Initialize the ledger. When the runtime provides `create_goal`, call it with
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
5. Invoke `deep-review` in light mode for the issue's current diff. Collect and
   adjudicate the whole result before editing; do not repair findings as
   reviewers arrive.
6. Repair valid product P0/P1 findings, run focused validation, and use at most
   one targeted recheck. Record P2/P3 findings as debt unless they directly
   violate the frozen issue outcome. Do not start another light-review loop once
   the targeted recheck has no product P0/P1.
7. Create one cohesive English commit. Record the commit, validation, and stable
   Acceptance ids in the ledger. Continue immediately to the next issue.

Do not capture final Acceptance evidence yet; later cross-issue repairs can make
it stale.

## Phase 2: deep review and PR delivery

After all issue commits:

1. Finish every gate likely to change code, including affected tests,
   changed-file checks, `knip`, `doctor`, builds, and focused Electron E2E. Then
   invoke the repository's `deep-review` skill in full deep mode over the whole
   Goal range.
2. Collect all reports for the round before adjudication. Repair valid product
   P0/P1 findings as one cohesive batch and run only affected validation.
   Delivery evidence, PR prose, and workflow bookkeeping never reopen product
   review.
3. Run at most three full Goal-range review rounds. After the third round, use
   at most one targeted verification for its remaining P0/P1 repairs; a further
   architecture-level P0/P1 requires a user decision instead of a fourth full
   review. Ignore reports for an older head unless their product P0/P1 reproduces
   on the current head.
4. When the current head has no product P0/P1, record and freeze it with
   `state.ts review --freeze`. A clean first or second round may freeze
   immediately; three rounds are a ceiling, not a target. P2/P3 findings become
   debt and cannot keep the loop open.
5. For a workflow, test-infrastructure, evidence, or PR-metadata-only commit,
   record a `verification` decision after focused validation. It requires an
   existing full product-review baseline, zero product P0/P1, and freezes the
   exact head without consuming another product review. Batch these repairs; a
   Go run permits at most three verification-only freezes by default. If late hosted evidence
   exposes another agent-owned verification defect, one fourth freeze is allowed only after the
   user explicitly authorizes that exact exception; record the authorization through
   `--verification-cap-authorization`. A fifth verification freeze is never allowed.
6. Push the branch and create a PR whose body maps issues to behavior and uses
   closing keywords for issues that should close on merge.
7. Recheck that the actual PR diff is exactly covered by the frozen Goal and its
   issue-level Acceptance coverage contract. A narrow Acceptance must never
   certify a broader PR.
8. Monitor CI, conflicts, review threads, and required checks. Do not busy poll.
9. Route code failures through repair, focused validation, one targeted review, commit,
   and push. A zero-step hosted-runner billing or infrastructure failure remains
   external and blocked. A verified GitHub Actions payment or spending-limit
   failure is automatically authorized for the documented exact-head local
   fallback; do not ask the user again. Other infrastructure failures still need
   separate authorization. Record the policy or user authorization before
   running the exact platform-neutral gates and one full isolated Electron E2E
   suite. Start the fallback only after the review-clean PR head is explicitly
   frozen. Never call the hosted check green.

Read [references/workflow.md](references/workflow.md) for the transition table
and repair routing.

## Phase 3: Acceptance loop

After the PR head is review-clean and either its required checks are green or an
exact-head local fallback has passed, have a fresh context-isolated tester
subagent independently draft the final Acceptance plan, then invoke the
project-local `acceptance` skill. Its only product surface is isolated macOS
Electron desktop.

Read [references/acceptance-loop.md](references/acceptance-loop.md) before the
first round. Give the planner the original requirement, admitted issue bodies,
stable check ids, exact PR head and diff, and the relevant product and Acceptance
contracts. Do not give it a builder-authored plan or expected verdicts. The root
agent adjudicates coverage and feasibility without weakening a check to fit the
implementation. If subagent execution is unavailable, pause before Acceptance
and ask for direction instead of silently substituting the builder's own plan.
The issue-level contracts already authorize the resulting in-scope cases; do not
add another routine confirmation gate.

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
   improvements, and token-efficiency findings. Read the accumulated audit notes
   from compact `resume --json`; if it reports truncation, use `state.ts notes
--json` instead of loading the full ledger.
5. Always identify concrete token waste from this run and repeated manual steps
   that should become scripts. Record both the observed cost and the prevention;
   explicitly say none was found instead of omitting either audit.
6. Apply obvious, narrow project-local workflow fixes when discovered early
   enough to remain inside the reviewed PR. Never silently mutate the active
   skill to change the current run's rules; an explicit user instruction may
   update it prospectively, after which focused skill validation and a new
   exact-head review freeze are required. Never recursively run self-improvement
   or append literal feedback as permanent policy.
7. Create follow-up issues for durable product debt. Keep larger or generic
   workflow proposals in the report or route them upstream.
8. Mark the Goal complete only after no required work remains. When the Goal has
   a token budget, report final usage returned by the Goal tool.

## Non-negotiable invariants

- Keep at most one issue actively progressing unless independent parallel work
  was explicitly authorized and the applicable skill requires it.
- Preserve user changes and unrelated dirty worktree state.
- Never treat passing tests, code review, PR merge, deployment, and Acceptance
  as interchangeable facts.
- Never run the full local Electron E2E suite during an ordinary run. The only
  exception is the exact-head, ledger-recorded external CI fallback authorized
  by project policy or the user as defined by the `test` skill and Go workflow
  reference. Run it only after the final head is frozen, normally once per Go
  run and never more than twice; after a second product failure, stop and report
  instead of starting a third full run.
- Never expose local report paths or internal verification-run URLs in the final
  handoff; expose the stable Acceptance URL.
- Never mark a Goal blocked merely because CI or human Acceptance is pending.

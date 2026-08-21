---
name: go
description: Manual-only multi-issue Caxri delivery orchestration.
disable-model-invocation: true
---

# Go

Run a durable, autonomous multi-issue delivery loop. Keep the Goal active from
the moment execution begins until the accepted or explicitly waived PR is merged, issue state is
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

Start every new run from the main checkout through the isolated-worktree entry
point before remote mutations:

```bash
bun run .agents/skills/go/scripts/start.ts \
  --objective "<business goal>" --branch "chore/<goal-slug>"
```

The command fetches and pins the latest `origin/main`, creates a dedicated
adjacent worktree and branch, verifies that the main checkout's branch, HEAD,
and working tree are unchanged, and initializes the ledger inside that
worktree. Store the returned worktree and state paths. Resume only inside that
recorded worktree. Update the ledger after every phase, issue, PR, Acceptance,
validation, cost checkpoint, or durable observation. Read
[references/state.md](references/state.md) before using the state script. Treat
GitHub and LobeHub as authoritative remote state; the ledger is the compact
resume index that prevents repeated discovery after context compaction. Resume
with `resume --json`; do not reload the full event history unless an audit needs
it. Record workflow observations in Simplified Chinese because they are
surfaced in the handoff report. Add a deduplicated `token_waste` or `workflow`
note as soon as a costly repeat or stable script candidate is observed; do not
reconstruct the audit by rereading the transcript at the end.

## Phase 0: admit work before starting the Goal

Read [references/intake.md](references/intake.md) in full.

1. Refresh the working tree, current branch, open issues, related PRs, and
   authentication state without modifying them. Use the intake snapshot so its
   canonical `lobehub whoami --json` probe fails closed before Acceptance work.
2. Normalize the user's requirements. Deduplicate them and classify each as
   execute now, already satisfied, defer, reject, or discuss before execution.
3. Before proposing issue solutions, Call the Skill tool with "competitors". Use current
   source evidence from relevant products, prefer VS Code for performance,
   security, filesystem, editor, IPC, and desktop-platform mechanics, and prefer
   Orca, Muxy, Kero, or another close workbench for UI and UX behavior.
4. Resolve every material product choice, scope expansion, external authority,
   destructive action, or unavailable prerequisite now. Do not knowingly carry
   an ordinary decision gate into the active Goal.
5. Split selected work into independently verifiable GitHub issues. Reuse an
   existing issue when it already owns the work. Otherwise, Call the Skill tool with
   "file-issue". Every admitted issue must contain explicit
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
   Acquire a durable `repair` mutation lease before changing the recorded worktree and release it
   only after the cohesive source/test batch is complete. Formal validation acquires its own
   mutually exclusive lease automatically; review and discovery remain read-only.
   At each owning-layer batch boundary, run the applicable changed-file check plus
   `doctor:changed` for Renderer work and `knip` for Renderer or shared-contract work. Reuse a
   matching trusted `origin/main` baseline receipt; when none exists, establish that baseline once
   rather than rediscovering the same pre-existing failure after every issue.
5. Compare the implementation, validation, and repair evidence with the issue's
   recorded diagnosis, solution, and Acceptance contract. Record an explicit
   expectation-drift assessment for the current issue head. Material drift
   requires a concise Simplified Chinese GitHub comment with `原预期`, `实际发现`,
   `处理决定`, and `验收影响`; equivalent refactors, test splits, formatting, and
   internal details record `none` without posting. A changed decision appends a
   new comment revision; never edit or duplicate the old comment. Scope-changing
   drift remains `decision_required` after its discovery comment and requires
   user direction.
6. For the issue's current diff, Call the Skill tool with "deep-review" in light mode. Collect and
   adjudicate the whole result before editing; do not repair findings as
   reviewers arrive.
7. Repair valid product P0/P1 findings, run focused validation, and use at most
   one light delta recheck. Record P2/P3 findings as debt unless they directly
   violate the frozen issue outcome. Do not start another light-review loop once
   the delta recheck has no product P0/P1.
8. Create one cohesive English commit. Reassess drift against the committed
   head, publish any required comment, then record the commit, validation, and
   stable Acceptance ids in the ledger. Issue completion fails closed when the
   assessment is missing, stale, unpublished, or awaiting a decision. Continue
   immediately to the next issue.

Before installing a new `@xterm/*` beta package, run `xterm-beta-line.ts` with
one `--resolve` per new package. Use only the exact specs it prints for `ni`;
the resolver must verify every manifest package and candidate against one
monorepo `gitHead` and the pinned `@xterm/xterm` peer contract first.

Do not capture final Acceptance evidence yet; later cross-issue repairs can make
it stale.

## Phase 2: deep review and PR delivery

After all issue commits:

1. Finish every gate likely to change code, including affected tests,
   changed-file checks, `knip`, `doctor`, builds, and focused Electron E2E. Then
   Call the Skill tool with "deep-review" in full deep mode over the whole
   Goal range.
   Record every canonical platform-neutral command through `validation-start` /
   `validation-complete` first; the ledger rejects a full aggregate review when any exact-head
   receipt is missing or stale. Reuse an already passed exact-head command instead of rerunning it.
   Before the first ready PR push, run the exact platform-neutral command list
   exported by `scripts/ci-fallback.ts`; its contract test keeps that list in
   lockstep with every executable `checks` step in `.github/workflows/ci.yml`.
2. Collect all reports for the round before adjudication. Repair valid product
   P0/P1 findings as one cohesive batch and run only affected validation.
   Delivery evidence, PR prose, and workflow bookkeeping never reopen product
   review.
3. Freeze the run's review policy before the aggregate review. The default is
   `full-once`: exactly one full Goal-range review is allowed for the entire
   ledger. `quick` or `light` may replace that baseline only through an explicit
   pre-review policy override.
4. Collect the aggregate review completely, repair its valid P0/P1 findings as
   one batch, then review only the exact code delta in light mode. Every light
   decision records the original baseline head/id, direct parent review id, and
   `parentHead..currentHead` range. Repeat light review only for a newly changed
   delta. If architecture, security, or frozen requirements change so much that
   light review is not credible, request a user decision; never start a second
   full review.
5. When the current head has no product P0/P1, freeze it with `state.ts review
--freeze`. Record CI, fixture, evidence, gates, and remote-state checks with
   `validation-start` / `validation-complete`, not as review modes. A validation
   records its exact head, command, session, artifact log, failure lineage, and
   final exit code. Recover a pending command before retrying, never rerun an
   uninvalidated passing exact-head gate, and stop when the lineage repair budget
   is exhausted.
6. Push the branch and create a PR whose body maps issues to behavior and uses
   closing keywords for issues that should close on merge. The PR cannot become
   ready until every in-scope issue's material drift is commented and every
   scope decision is resolved.
7. Recheck that the actual PR diff is exactly covered by the frozen Goal and its
   issue-level Acceptance coverage contract. A narrow Acceptance must never
   certify a broader PR.
8. Monitor CI, conflicts, review threads, and required checks. Do not busy poll.
   Before starting two or more long-running remote validations, tell the user
   the frozen run count, the minimum wall time implied by recent runs, why each
   sample is required, and the stop condition. Record run ids as they are
   dispatched instead of reconstructing an A/B table from the transcript.
   A failing E2E pool retains the fast `maxFailures` stop, then census-runs each suppressed test in
   isolation. Do not start a repair or push a new head until both logical pool receipts classify
   every planned spec and the combined failure groups are available.
9. Route code failures through repair, focused validation, one light delta
   review, commit, and push. A zero-step self-hosted Actions infrastructure
   failure remains external and blocked. Exact-head local substitution always
   needs separate user authorization. Record the authorization before running
   the exact platform-check gates and one full isolated Electron E2E suite.
   Start the fallback only after the review-clean PR head is explicitly frozen.
   Never call the Actions check green.

Read [references/workflow.md](references/workflow.md) for the transition table
and repair routing.

## Phase 3: Acceptance loop

After the PR head is review-clean and either its required checks are green or an
exact-head local fallback has passed, have a fresh context-isolated tester
subagent independently draft the final Acceptance plan. Then Call the Skill tool with
"acceptance". Its only product surface is isolated macOS
Electron desktop. If the frozen issues have no product or desktop claim and the
user explicitly waives Acceptance for the exact head, record the waiver and
reason, transition directly from `delivery` to `acceptance_handoff`, and do not
invent desktop evidence.

Read [references/acceptance-loop.md](references/acceptance-loop.md) before the
first round. Give the planner the original requirement, admitted issue bodies,
stable check ids, exact PR head and diff, and the relevant product and Acceptance
contracts. Do not give it a builder-authored plan or expected verdicts. The root
agent adjudicates coverage and feasibility without weakening a check to fit the
implementation. If subagent execution is unavailable, pause before Acceptance
and ask for direction instead of silently substituting the builder's own plan.
The issue-level contracts already authorize the resulting in-scope cases; do not
add another routine confirmation gate.

Before the first launch, reject any plan that tries to prove hidden callback
ordering solely through desktop timing. Keep the business requirement intact,
but express its evidence as the observable desktop outcome plus the smallest
focused test or log receipt that owns the internal ordering contract. One
published blocked round is enough to diagnose an infeasible evidence method;
repair the method once rather than extending the run with ad hoc timing probes.

- Publish failures discovered after round execution starts; never silently fix
  and erase the failed snapshot.
- Route in-scope product failures back to their issue, repair, review, commit,
  push, and a new immutable round.
- Route evidence, adapter, fixture, or report failures to validation repair,
  not product code.
- File unrelated discoveries as follow-up issues and continue only when they do
  not weaken the accepted business requirement.
- After a passing round, transition to `acceptance_handoff`, generate the
  exact-head `handoff-report.md`, validate its checksum and required sections,
  and deliver its full summary with the stable Acceptance URL. Record
  `deliveredAt` only after that user handoff. Then transition to
  `waiting_acceptance` while keeping the Goal active and yield control.
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

1. Merge the accepted or explicitly waived PR and verify its remote merged SHA.
2. Verify every intended issue is closed. Close an authorized issue directly
   only when merge automation did not.
3. Refresh all remote state before reporting it.
4. Read [references/report.md](references/report.md). Reuse the already persisted
   handoff report rather than regenerating it. Write `finalization.json` from
   refreshed remote evidence for the accepted/waived head, merged PR, merge SHA,
   every intended closed issue, and Project `Done` state. The generated command
   output is the brief final-response template; include its `Workflow 改进` and
   `自动化候选` sections even when either contains an explicit none entry. Record
   both delivery timestamps before completion.
5. Always identify concrete token waste from this run and repeated manual steps
   that should become scripts. Record both the observed cost and the prevention;
   explicitly say none was found instead of omitting either audit.
   Treat a status question or complaint about elapsed time as an immediate cost
   checkpoint: answer with completed work, the current wait, remaining required
   gates, and a revised lower-bound ETA before launching anything else. Drop
   optional proof that no longer changes the frozen delivery decision.
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
- Run each new Goal in the dedicated worktree pinned by `start.ts`; never move a
  resumed Goal back to the main checkout or another worktree.
- Preserve user changes and unrelated dirty worktree state.
- In zsh orchestration snippets, never assign to special parameters such as `path`, which is tied
  to command lookup through `$PATH`; use a task-specific variable name instead.
- Never treat passing tests, code review, PR merge, deployment, and Acceptance
  as interchangeable facts.
- Never run the full local Electron E2E suite during an ordinary run. The only
  exception is the exact-head, ledger-recorded external CI fallback authorized
  by project policy or the user as defined by the `e2e-testing` skill and Go workflow
  reference. Run it only after the final head is frozen, normally once per Go
  run and never more than twice; after a second product failure, stop and report
  instead of starting a third full run.
- Never expose local report paths or internal verification-run URLs in the final
  handoff; expose the stable Acceptance URL.
- Never mark a Goal blocked merely because CI or human Acceptance is pending.

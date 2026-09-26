---
name: go
description: Manual-only multi-issue Caxri delivery orchestration.
disable-model-invocation: true
---

# Go

Run a durable, autonomous multi-issue delivery loop. Keep the Goal active from the moment
execution begins until the accepted or explicitly waived PR is merged, issue state is verified,
and the execution report is complete.

Explicit invocation authorizes the in-scope local and remote workflow described here: create or
update GitHub issues, edit and validate code, create commits, push the working branch, create and
update a PR, publish LobeHub Acceptance rounds, merge an accepted PR, close its issues, and
directly repair narrow project-local `AGENTS.md`, skill, or Acceptance-adapter defects discovered
by the run. It does not authorize unrelated work, destructive data operations, secrets, account
changes, releases, or an unapproved expansion of the business goal.

## Durable state

Start every new run from the main checkout through the isolated-worktree entry point before remote
mutations:

```bash
bun run .agents/skills/go/scripts/start.ts \
  --objective "<business goal>" --branch "chore/<goal-slug>"
```

The command fetches and pins the latest `origin/main`, creates a dedicated adjacent worktree and
branch, verifies that the main checkout's branch, HEAD, and working tree are unchanged, and
initializes the ledger inside that worktree. Store the returned worktree and state paths. Resume
only inside that recorded worktree. Update the ledger after every phase, issue, PR, Acceptance,
validation, cost checkpoint, or durable observation. Read [references/state.md](references/state.md)
before using the state script. Treat GitHub and LobeHub as authoritative remote state; the ledger
is the compact resume index that prevents repeated discovery after context compaction. Resume with
`resume --json`; do not reload the full event history unless an audit needs it. Record workflow
observations in Simplified Chinese because they are surfaced in the handoff report. Add a
deduplicated `token_waste` or `workflow` note as soon as a costly repeat or stable script candidate
is observed; do not reconstruct the audit by rereading the transcript at the end.

The ledger accepts only the current schema v1. Do not migrate an older Go ledger; start a new run
instead.

Treat the ledger as a cooperative consistency and resume contract. It validates recorded state
transitions, exact-head and source fingerprints, and receipt lineage. It does not execute the
recorded commands, derive review findings, attest facts omitted by the caller, or provide an
adversarial security boundary. Actual command output, independent review or Acceptance, and remote
GitHub/LobeHub readback remain the corresponding evidence sources.

## Phase 0: admit work before starting the Goal

Read [references/intake.md](references/intake.md) in full.

1. Refresh the working tree, current branch, open issues, related PRs, and authentication state
   without modifying them. Use the intake snapshot so its canonical `lh whoami --json` probe
   fails closed before Acceptance work.
2. Normalize the user's requirements. For every existing issue the request names, dispatch a
   read-only verifier subagent that checks the problem is still real at the current head, weighs
   the user-visible value against what the change touches, and reports how well the issue was
   thought through; adjudicate its verdict against the source. Then deduplicate the requirements
   and classify each as execute now, already satisfied, defer, reject, or discuss before
   execution. A named issue with a weak or superseded verdict is discussed before the Goal, not
   executed as written and not silently skipped.
   An existing issue whose Caxri project Status is `Backlog` classifies as defer:
   that Status is the owner saying "not yet". Admit it only when the owner names that issue
   explicitly in the current request. Report every issue skipped this way instead of dropping it
   silently. `file-issue` owns the full Status lifecycle.
3. Before proposing issue solutions, Call the Skill tool with "competitors". Use current source
   evidence from relevant products, prefer VS Code for performance, security, filesystem, editor,
   IPC, and desktop-platform mechanics, and prefer Orca, Muxy, Kero, or another close workbench for
   UI and UX behavior.
4. Resolve every material product choice, scope expansion, external authority, destructive action,
   or unavailable prerequisite now. Do not knowingly carry an ordinary decision gate into the
   active Goal.
5. Split selected work into independently verifiable GitHub issues. Reuse an existing issue when it
   already owns the work. Otherwise, Call the Skill tool with "file-issue". Every admitted issue
   must contain explicit `UX 设计` and `Acceptance 方案` sections, including a reason when no
   direct UI claim exists.
6. Freeze dependencies, priorities, execution order, issue completion criteria, UX decisions,
   stable Acceptance check ids, and the issue-level Acceptance coverage contract. Do not
   pre-author the final case execution plan; a fresh tester subagent derives it from the stable
   delivered head. Produce one compact execution plan.
7. Initialize the ledger. When the runtime provides `create_goal`, call it with the concrete
   objective and do not set a token budget unless the user explicitly requested one. In a
   compatible client without that tool, transition the ledger to active execution and use it as
   the durable Goal marker; do not pause or pretend a missing tool call succeeded.

Once the Goal starts, continue autonomously through routine repairs, restarts, reviews, commits,
remote checks, and Acceptance rounds. A wait for CI or human Acceptance is an active workflow
state, not a completed or blocked Goal.

## Phase 1: execute each issue

For each queued issue in dependency order:

1. Refresh the issue and mark it `progressing` in the run ledger and the owning remote workflow
   when one exists.
2. Reconfirm the current source and the issue's observable completion criteria.
3. For a reproducible bug, add or identify the failing behavior regression before fixing it.
   Finish source edits before updating tests when project instructions require that order.
4. Implement the smallest cohesive solution and run only affected validation. Acquire a durable
   `repair` mutation lease before changing the recorded worktree and release it only after the
   cohesive source/test batch is complete. Formal validation acquires its own mutually exclusive
   lease automatically; review and discovery remain read-only. At each owning-layer batch
   boundary, run the applicable changed-file check plus `doctor:changed` for Renderer work and
   `knip` for Renderer or shared-contract work. Reuse a matching trusted `origin/main` baseline
   receipt; when none exists, establish that baseline once rather than rediscovering the same
   pre-existing failure after every issue.
5. Compare the implementation, validation, and repair evidence with the issue's recorded
   diagnosis, solution, and Acceptance contract. Record an explicit expectation-drift assessment
   for the current issue head. Material drift requires a concise Simplified Chinese GitHub comment
   with `原预期`, `实际发现`, `处理决定`, and `验收影响`; equivalent refactors, test splits,
   formatting, and internal details record `none` without posting. A changed decision appends a
   new comment revision; never edit or duplicate the old comment. Scope-changing drift remains
   `decision_required` after its discovery comment and requires user direction.
6. For the issue's current diff, Call the Skill tool with "deep-review" in light mode. Collect and
   adjudicate the whole result before editing; do not repair findings as reviewers arrive.
7. Repair valid product P0/P1 findings, run focused validation, and use at most one light delta
   recheck. Record P2/P3 findings as debt unless they directly violate the frozen issue outcome.
   Do not start another light-review loop once the delta recheck has no product P0/P1.
8. Create one cohesive English commit. Reassess drift against the committed head, publish any
   required comment, then record the commit, validation, and stable Acceptance ids in the ledger.
   Issue completion fails closed when the assessment is missing, stale, unpublished, or awaiting a
   decision. Continue immediately to the next issue.

Before installing a new `@xterm/*` beta package, run `xterm-beta-line.ts` with one `--resolve` per
new package. Use only the exact specs it prints for `ni`; the resolver must verify every manifest
package and candidate against one monorepo `gitHead` and the pinned `@xterm/xterm` peer contract
first.

Do not capture final Acceptance evidence yet; later cross-issue repairs can make it stale.

## Phase 2: deep review and PR delivery

After all issue commits:

1. Complete every code-changing gate selected by the dirty layers, then record its exact-head
   receipt. Before the first ready PR push, record the platform-neutral commands exported by
   `.agents/skills/go/scripts/ci-fallback.ts` locally, or use a successful exact-head full CI run
   that actually executed them. Pull-request synthetic-merge checks do not count as exact-head receipts.
2. Freeze the review policy. The default is `full-once`: Call the Skill tool with "deep-review" in
   full deep mode exactly once over the whole Goal range.
3. A review round is adjudicated as one complete set. Repair valid P0/P1 roots in one cohesive
   batch, rerun affected gates, and use light mode only for the exact repair delta. If that delta
   cannot credibly cover an architecture, security, or frozen-requirement change, request a user
   decision instead of starting another full review.
4. Freeze a current head only when it has no product P0/P1 and every receipt is current. CI,
   fixtures, evidence, gates, and remote-state checks are validations, never review modes.
5. Push one branch and create one PR whose issue map, closing keywords, and diff exactly match the
   frozen Goal and Acceptance coverage contract.
6. Monitor checks, conflicts, and review threads without busy polling. A code failure returns
   through repair, focused validation, light delta review, commit, and push. A zero-step external
   Actions failure remains blocked; exact-head local substitution requires separate authorization
   and never makes Actions green.

Read [references/workflow.md](references/workflow.md) for the transition table and repair routing.

## Phase 3: Acceptance loop

Read [references/acceptance-loop.md](references/acceptance-loop.md) before the first round. After
the PR head is review-clean and required checks are green, or an authorized exact-head local
fallback has passed, proceed to planning. A fresh context-isolated tester authors the final plan
independently. Do not give it a builder-authored plan or expected verdicts. Then Call the Skill
tool with "acceptance". Its product surfaces are isolated macOS Electron desktop and explicitly
selected Android/iOS mobile targets. Each check names the reviewer-facing surface, and a
cross-device workflow may use evidence from both. Hidden ordering uses the observable product
result plus an owning focused test or log receipt; device timing alone is not proof. Builders never
accept or reject their own delivery, and any later code change invalidates the accepted head.

If the frozen issues have no Caxri product-surface claim and the user explicitly waives Acceptance
for the exact head, record the head and reason, transition to `acceptance_handoff`, and do not
invent product evidence.

## Phase 4: merge, close, and learn

Read [references/report.md](references/report.md). Merge only the accepted or explicitly waived
head, refresh the merged SHA, and verify every intended issue is closed with its Project item
`Done`. Reuse the persisted handoff report, generate and deliver the final remote receipt, then run
the final resource audit before transitioning to `complete`:

```bash
bun run .agents/skills/go/scripts/state.ts resource-audit \
  --state "$GO_STATE" [--recovered worktree_process]
```

The audit checks the current ledger for pending validation or mutation ownership, the dedicated
worktree's managed dev process and desktop lease, Acceptance runtime state, abandoned Go temporary
files, and live processes whose cwd or command resolves inside the recorded worktree. It excludes
the audit command and its ancestors. It records no command arguments or raw process output.

When the audit reports a candidate, inspect and reclaim it through its owning procedure: Call the
Skill tool with "debug" for worktree processes, Call the Skill tool with "switch-worktree" for a
managed dev instance or desktop lease, and Call the Skill tool with "acceptance" for Acceptance
runtime cleanup. Verify PID plus process identity and the exact recorded worktree before signaling;
never use a broad process-name match. Remove a reported temporary only after proving it is a direct
regular file inside this run directory and no live writer owns it. Rerun `resource-audit`, adding
one `--recovered KIND` for each resource category actually reclaimed. Do not automatically delete
the Go worktree, isolated profile, local branch, or remote branch: those are retained delivery
resources, not abnormal residue.

Any later mutating state command invalidates the audit, so run it last and transition directly to
`complete`. A delivered finalization receipt or merged PR never substitutes for this check. Include
the resource cleanup result with the explicit workflow, automation, cost, debt, and
remaining-boundary results.

Only an explicit user instruction may update this skill while its workflow is active; the update
applies prospectively and requires focused validation plus a new exact-head review freeze. Never
recursively self-improve. Mark the Goal complete only after the delivery and finalization receipts
are delivered and the final resource-cleanup receipt is recorded.

## Non-negotiable invariants

- Keep at most one issue actively progressing unless independent parallel work was explicitly
  authorized and the applicable skill requires it.
- Run each new Goal in the dedicated worktree pinned by `start.ts`; never move a resumed Goal back
  to the main checkout or another worktree.
- Preserve user changes and unrelated dirty worktree state.
- Never treat passing tests, code review, PR merge, deployment, and Acceptance as interchangeable
  facts.
- Never run the full local Electron E2E suite during an ordinary run. The only exception is the
  exact-head, ledger-recorded external CI fallback authorized by project policy or the user as
  defined by the `e2e-testing` skill and Go workflow reference. Run it only after the final head
  is frozen, normally once per Go run and never more than twice; after a second product failure,
  stop and report instead of starting a third full run.
- Never expose local report paths or internal verification-run URLs in the final handoff; expose
  the stable Acceptance URL.
- Never mark a Goal blocked merely because CI or human Acceptance is pending.

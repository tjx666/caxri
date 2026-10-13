# Execution State Machine

Use these phases as durable checkpoints. Before each transition, record or
refresh the phase's cost checkpoint. The ledger adds an explicit `unavailable`
checkpoint when the runtime cannot provide exact metrics.

## Batch ownership

- Freeze the live issue set and issue-level Acceptance matrix before editing. Separate
  already-satisfied work, decision-only items, deferred work, and implementation work.
- Group implementation and validation by owning layer or shared root cause while keeping every
  issue's observable completion and Acceptance checks explicit.
- Prefer cohesive commits with independently verifiable behavior. Honor an explicit request for one
  commit, but never create a mixed commit merely because several issues entered one Goal.

| Phase                | Entry condition                                  | Exit condition                                                                | Allowed return                     |
| -------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------- |
| `intake`             | `$go` explicitly invoked                         | Requirements classified                                                       | none                               |
| `planning`           | Material decisions resolved                      | Issue queue, review policy, and Acceptance contracts frozen                   | `intake` before Goal creation      |
| `issue_execution`    | Goal active in its dedicated worktree            | Every queued issue has a reviewed commit                                      | same phase for repair              |
| `deep_review`        | Issue queue complete                             | One aggregate baseline plus any light repair delta is review-clean and frozen | `issue_execution`                  |
| `delivery`           | Frozen review-clean branch                       | PR checks and remote review clear                                             | `deep_review`                      |
| `acceptance`         | Stable head and tester-authored plan             | Passing round published                                                       | `issue_execution` or `deep_review` |
| `acceptance_handoff` | Passing round or explicit exact-head waiver      | Complete exact-head report generated and delivered when waiting               | `acceptance` or review phases      |
| `waiting_acceptance` | Report delivered with stable Acceptance URL      | Human accepts or rejects                                                      | `acceptance`                       |
| `merge`              | Human accepted or explicitly waived current head | PR remotely merged                                                            | `deep_review` if code changes      |
| `finalization`       | Merged PR                                        | Final receipt delivered; resource audit clean or recovered                    | none                               |
| `complete`           | Handoff, finalization, and resource receipts     | Terminal                                                                      | none                               |

## Per-issue loop

```text
queued → progressing → implement → focused validation → light issue review
       ↖                 repair valid findings                       ↙
                    commit → complete
```

Create a behavior-level failing regression first when the bug is cheaply
reproducible. Keep commits cohesive and independently explainable. A shared root
cause may satisfy multiple issues, but the ledger and issue-level Acceptance
contracts retain each observable outcome.

For a new `@xterm/*` beta dependency, resolve its package-specific beta number
before installation; monorepo packages published from one commit do not share a
common beta suffix:

```bash
bun run .agents/skills/go/scripts/xterm-beta-line.ts \
  --resolve @xterm/addon-webgl
```

The command performs no install. It verifies existing exact manifest pins, the
candidate's `gitHead`, and its `@xterm/xterm` peer range, then prints the exact
specifier to pass to `ni`. Never guess an addon's beta suffix from the core
package version.

Before completion, compare the observed implementation and evidence with the
issue's public expectation. Record an explicit assessment for the issue commit.
Material root-cause, architecture, Acceptance, scope, compatibility, or
already-satisfied drift must be published through the structured GitHub comment
before completion. Equivalent refactors, test splits, formatting, and internal
details remain `none` and do not create noise. A publication failure stays
`detected` for resume. A scope-changing discovery stays `decision_required`
after its discovery comment; comments never expand the frozen Goal.

## Aggregate review policy and lineage

Freeze `reviewPolicy` before the aggregate review. The default is `full-once`;
an explicit user decision may select `quick` or `light` before the first review
decision. The policy cannot change after the baseline starts.

```text
code-changing gates → one aggregate baseline → repair P0/P1 → light delta review
                              │                         │
                              └──── freeze clean head ─┘
```

- Complete `knip`, `doctor`, affected builds, and focused Electron E2E before
  the baseline so late gates do not reopen a declared-clean head.
- The review policy permits at most one full review. Every later code-changing repair is
  `light` and binds `baselineReviewId`, `baselineHeadSha`, `parentReviewId`, and
  the exact `parentHead..currentHead` range.
- If an architecture, security, or frozen-requirement change cannot credibly be
  covered as a delta, request a user decision. Do not silently run another full
  review.
- P2/P3, stale evidence, PR copy, and workflow bookkeeping do not keep product
  review open. Record debt or fix delivery metadata in its owning phase.
- A report against an old head is advisory. It can reopen work only when its
  product P0/P1 reproduces against the current head.

Use `state.ts review` only for review decisions. CI, fixtures, evidence, gates,
and remote-state checks use `validation-run`, with the executable and argument vector after `--`.
For a full baseline, `review` may also reuse a successful full platform-check job from an exact-head
`push` or `workflow_dispatch` CI run. It records the run URL and per-command source in the review
round. Current pull-request checks run on a synthetic merge and cannot substitute for exact-head
receipts.
Each validation automatically stores the exact head, secret-free command identity, argument count, session id, private log path,
failure lineage, attempt, duration, final exit code or signal, log size and SHA-256, and effective
result. The runner streams output while it executes outside the short ledger locks, launches with a
credential-free environment allowlist, applies bounded log backpressure and a wall-clock deadline, and records the
supervised process identity before the command can start. It
recovers a dead managed runner before retrying and never repeats a passed exact-head command. Caller interruption
and runner loss do not consume the repair budget; a real failure lineage gets at most the configured
repair attempts.

## Scope and cost stop-loss

Record cumulative exact token, elapsed-time, commit, and file counts when the
runtime provides them; otherwise write `unavailable`. At each workflow-only
scope decision, run `checkpoint` and `scope-admit`.

- Blocking work required for the frozen delivery stays in the current Goal.
- After the configured token or elapsed-time hard threshold, non-blocking skill,
  report, workflow, or CI improvement becomes a follow-up issue and is listed in
  the handoff report.
- A hard threshold never permits leaving a safety repair half-applied or the
  repository broken.

## Discovery routing

| Discovery                                         | Route                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| In-scope regression or missing requirement        | Reopen the owning issue and repair now                                                      |
| New defect that blocks the frozen business goal   | Create a blocking issue and insert it into the queue                                        |
| Unrelated pre-existing defect                     | Create or update a follow-up issue; do not expand this Goal                                 |
| Validation infrastructure defect                  | Repair the owning adapter, fixture, capture, or report tooling only when it blocks delivery |
| Zero-step hosted Actions infrastructure failure   | Keep externally blocked; preserve logs and retry only after the cause is addressed          |
| Durable product technical debt                    | Record it and create a follow-up issue before completion                                    |
| Non-blocking workflow improvement after threshold | Route through `scope-admit` to a follow-up                                                  |
| Issue expectation differs materially              | Append a structured issue comment; request a decision before scope expansion                |

## Guarded local CI fallback

Inside `$go`, local substitution always requires separate user authorization. Admit a fallback only
when:

- the current-head Actions job failed before execution with zero executed steps;
- the cause is external infrastructure, not repository code/tests;
- the original GitHub failure text is recorded;
- the user authorizes the exact-head substitution;
- the exact PR head and aggregate/light review lineage are frozen.

Run the platform-neutral commands exported by `ci-fallback.ts`, in order, followed by one `bun run
test:e2e` on the same clean head. Both surfaces must pass before Acceptance. Keep the PR
`checks_blocked`; local evidence never turns the Actions check green. Normally one full Electron
E2E is allowed. A product failure or human rejection can permit one final run after a new reviewed
head; state validation refuses a third. This generic, explicit fallback is separate from the future
`hosted-full` route, whose every dispatch or retry still needs fresh maintainer authorization. The
[Go skill](../SKILL.md) owns the cooperative ledger trust model; this gate does not independently
attest the recorded command result.

## Waiting without token churn

- Prefer event-driven waits or the runtime monitoring mechanism.
- On continuation, query each pending remote system once.
- After delivering the report and Acceptance URL, yield to the user. Do not
  poll, rerun tests, regenerate reports, or restate the plan while pending.
- Never mark the Goal complete or blocked only because human review is pending.

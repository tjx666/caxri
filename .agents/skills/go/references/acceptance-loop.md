# Acceptance Repair Loop

Invoke the project-local `acceptance` skill for the detailed report and evidence
protocol. Caxri has one product surface for this workflow: isolated macOS
Electron desktop.

## Before the first round

1. Read `.agents/acceptance/PROJECT.md` and resolve its current build, CDP, and
   isolated-profile commands.
2. Confirm LobeHub production authentication.
3. Assemble a bounded planner packet containing the original business
   requirement, admitted issue bodies, their UX and Acceptance sections, stable
   check ids, the exact PR head and diff summary, and the relevant product,
   design, and Acceptance evidence contracts.
4. Spawn one fresh context-isolated tester subagent named
   `acceptance_plan_tester`. Keep it read-only, forbid nested delegation, and do
   not give it a builder-authored case plan, implementation rationale, intended
   verdicts, or prior evidence selection.
5. Require the tester to inspect the current source and independently return:
   - a report-compatible `plan[]` using the frozen stable ids;
   - an issue-to-check coverage map;
   - required fixtures, failure injection, and setup assumptions;
   - coverage gaps, duplicate checks, or claims that cannot be proven with the
     proposed evidence.
6. Direct the tester to start from user journeys and plausible failure modes.
   Prefer real UI screenshots or video whenever the result is visible; use DOM,
   structured logs, or text only for claims the UI cannot faithfully expose.
   A visual check must prove the behavior or state, not merely that an element
   exists.
7. Adjudicate the proposal against the original requirement, every admitted
   issue, and the exact PR diff. Resolve missing coverage before freezing the
   plan; do not weaken an expected result to match the implementation. If a
   material product choice or scope expansion is required, return to the owning
   workflow phase instead of improvising it in Acceptance.
8. If subagent execution is unavailable, pause and ask the user for direction.
   Do not silently let the builder author the plan and call it independent.
9. Write the adjudicated frozen plan before executing cases.
10. Use the Acceptance report scaffold to initialize a fresh round directory
    under the current Go ledger directory.

The first requirement is one immutable sentence describing the whole business
goal, not the current repair. Write the requirement and all human-facing report
content in Simplified Chinese as required by the Acceptance report reference.

## Evidence policy

- Use the real desktop surface for every user-visible claim.
- Use a screenshot for settled layout or state and inspect the image before
  citing it.
- Use GIF or video for streaming, animation, loading, replay, timers, or any
  claim about change over time.
- Use focused command output, logs, or probes only as supporting text evidence.
- Attach separate reasoning and execution artifacts for non-visual behavioral
  claims.
- Keep every planned check visible even when it fails or cannot run.

## When execution discovers a problem

Once a round starts, fill it faithfully and publish it whenever the report can
be ingested:

| Problem                                           | Round verdict                         | Next action                                                                           |
| ------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| Caxri violates an in-scope check                  | `fail`                                | Publish, map stable id to issue, repair code, review, commit, push, start a new round |
| Environment or fixture prevents the check         | `partial` / blocked case              | Publish, repair agent-owned infrastructure, start a new round                         |
| Screenshot is black, stale, wrong, or uninspected | failed/blocked evidence coverage      | Repair capture; never claim product pass                                              |
| Report schema or upload drops evidence            | invalid publication                   | Preserve any created round, correct locally, publish a new round                      |
| Unrelated defect is observed incidentally         | Do not alter an otherwise valid check | File a follow-up issue and state the boundary                                         |

Do not publish every focused test failure from implementation. The immutable
history begins when the Acceptance plan is frozen and round execution starts.

## Human review state

After a passing round:

1. Store the acceptance id, URL, round index, and `pending` state in the ledger.
2. Transition the local workflow to `waiting_acceptance`; keep the Codex Goal
   active.
3. Run `state.ts resume --state "$STATE" --json` and give the user the stable
   Acceptance URL plus its compact `workflowObservations`. Do not duplicate the
   full post-merge technical-debt, workflow, or token-efficiency audit here.
4. End the current turn. Do not keep
   a shell poller running, short-poll from the agent loop, or narrate unchanged
   pending state.
5. On a later user or automatic continuation, query the filtered `status` and
   `userDecision` fields once using the Acceptance report reference. Treat an
   explicit `userDecision` as authoritative even if an auxiliary review flag is
   stale, or wait by event when supported.
6. Never call `lobehub acceptance accept` or `reject` as the builder.

On rejection:

1. Fetch actionable feedback using the Acceptance report reference.
2. Ignore stale feedback and omit user-accepted checks unless the repair can
   regress them.
3. Reuse rejected stable ids. Use `supersedes` only for a semantic replacement
   and preserve its complete lineage.
4. Transition `waiting_acceptance → acceptance → issue_execution` (or
   `deep_review` for a cross-issue repair) before changing the PR head.
5. Repair, validate, review, commit, and push.
6. Rerun rejected and regression-affected checks in a new immutable round.

On acceptance, merge only the exact accepted PR head. A conflict resolution or
any other code change requires review and a new Acceptance round.

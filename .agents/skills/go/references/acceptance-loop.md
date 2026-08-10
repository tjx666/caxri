# Acceptance Repair Loop

Invoke the project-local `acceptance` skill for the detailed report and evidence
protocol. Caxri has one product surface for this workflow: isolated macOS
Electron desktop.

## Before the first round

1. Read `.agents/acceptance/PROJECT.md` and resolve its current build, CDP, and
   isolated-profile commands.
2. Confirm LobeHub CLI authentication.
3. Reuse the stable check ids frozen during Go intake.
4. Write the frozen plan before executing cases.
5. Use the Acceptance report scaffold to initialize a fresh round directory
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

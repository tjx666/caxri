# Acceptance Repair Loop

Call the Skill tool with "acceptance" for the detailed report and evidence
protocol. Caxri uses isolated macOS Electron desktop and explicitly selected Android/iOS mobile
surfaces. A companion workflow may require both, while each check names the reviewer-facing
`desktop` or `mobile` surface.

## Before the first round

1. Read `.agents/acceptance/PROJECT.md` and resolve the current build, device, capture, and
   state-isolation commands for every planned surface.
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
   Default `stateIsolation` to `isolated`; state-mutating checks must use their
   own named launch/profile. A restart check explicitly names the reusable
   profile and final cleanup owner.
10. Use the Acceptance report scaffold to initialize a fresh round directory
    under the current Go ledger directory.

The first requirement is one immutable sentence describing the whole business
goal, not the current repair. Write the requirement and all human-facing report
content in Simplified Chinese as required by the Acceptance report reference.

## Evidence policy

- Use the real selected product surface for every user-visible claim. Cross-device checks may
  include desktop supporting evidence while remaining `surface: "mobile"` when the mobile outcome
  is what the reviewer decides.
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

Before publishing the **first** round, hand the finalized report, the per-case evidence index, and
an explicit file list with the relevant diff to one read-only `acceptance-checker` for a single
quick evidence review, following the Acceptance skill's
`references/acceptance-checker.md`. `acceptance_plan_tester` already owns the plan gate here, so
run only that evidence stage; follow-up rounds have neither. Replace this round's `proposal.md`
placeholder before publishing — ingest posts it into the acceptance discussion, and `finalize`
refuses the untouched placeholder.

Before a Terminal fixture capture, run the Acceptance fixture preflight. It
uses terminal cell width rather than UTF-16 length and verifies generation,
first grid marker, DOM rows, grid dimensions, and both border columns. A failed
preflight is `fixture_blocked`; it is never a product verdict.

## Human review state

After a passing round:

1. Store the acceptance id, URL, round index, and `pending` state in the ledger.
   Inside Go, publish only through `state.ts acceptance-publish`; it forces
   `--acceptance` after round one and reads the remote round back before updating
   the ledger. The ordinary `state.ts acceptance` status command never accepts
   `--round`; use `acceptance-reconcile-round` only for an explicitly documented
   ledger repair. Record accidental standalone history with `acceptance-orphan`.
   If the authenticated principal can read a public frozen Acceptance but cannot
   append to it, confirm the ownership mismatch and absence of a pending attempt,
   then use `acceptance-restart-lineage` with the active id and an explicit reason.
   The command preserves the old publication receipt as orphan history and resets
   only the active lineage; publish the replacement from a fresh `round-1` directory.
2. Transition to `acceptance_handoff`. Run the read-only workflow and cost audit,
   then generate `handoff-report.md` for the exact PR head.
3. Deliver the report's complete summary with the stable Acceptance URL. Record
   `deliveredAt` only after the user-facing handoff, then transition to
   `waiting_acceptance`; keep the Codex Goal active.
4. Run `state.ts resume --state "$STATE" --json` to confirm the report receipt
   and pending decision, then end the current turn. Do not keep
   a shell poller running, short-poll from the agent loop, or narrate unchanged
   pending state.
5. On a later user or automatic continuation, query the filtered `status` and
   `userDecision` fields once using the Acceptance report reference. Treat an
   explicit `userDecision` as authoritative even if an auxiliary review flag is
   stale, or wait by event when supported.
6. Never call `lh acceptance accept` or `reject` as the builder.

On rejection:

1. Fetch actionable feedback using the Acceptance report reference.
2. Ignore stale feedback and omit user-accepted checks unless the repair can
   regress them.
3. Reuse rejected stable ids. Use `supersedes` only for a semantic replacement
   and preserve its complete lineage.
4. Transition `waiting_acceptance → acceptance → issue_execution` (or
   `deep_review` for a cross-issue repair) before changing the PR head.
5. Acquire the Go repair mutation lease before source edits and release it after
   the edit batch, before formal ledger validation (see [state.md](state.md)).
   Repair, validate, review, commit, and push.
6. Rerun rejected and regression-affected checks in a new immutable round.

On acceptance, merge only the exact accepted PR head. A conflict resolution or
any other code change requires review and a new Acceptance round.

When the frozen issue set has no Caxri product-surface claim, an explicit
user instruction may waive Acceptance for one exact head. Record the reason and
head, transition `delivery → acceptance_handoff`, generate the report, and skip
the surface planner/round. The waiver does not bypass review, CI, report,
finalization, merge, or issue-state gates.

# Handoff Report and Finalization

Write user-facing report content in Simplified Chinese. Keep code, identifiers,
commit subjects, and PR content in English. Reference GitHub objects with the
repository-qualified markdown form required by `AGENTS.md`.

## Pre-wait handoff report

Generate `.records/go/<run-id>/handoff-report.md` during
`acceptance_handoff`, before entering human wait. The persisted report is bound
to the exact delivered head and includes a checksum, generation time, delivery
time, and all required section receipts.

Required sections:

1. **Delivery**: issue map, observable outcome, commits, focused validation,
   expectation-drift assessment status, and published decision-comment URLs.
2. **Review**: frozen policy, aggregate baseline, light repair lineage, and P0/P1 disposition.
3. **Technical debt**: durable debt and any follow-up issue, or an explicit none.
4. **Workflow**: project skill or `AGENTS.md` changes plus unapplied recommendations.
5. **Cost**: exact available token/time/commit/file checkpoints and Actions use; write `unavailable` instead of estimates.
6. **Automation**: repeated judgment-free sequences and the implemented or proposed script boundary.
7. **Remaining boundaries**: exclusions, deferred work, release/deployment limits, and unclaimed evidence.

For a normal Acceptance round, deliver the complete report summary together
with the stable Acceptance URL and then record `deliveredAt`. A generated file,
an internal note, a checksum without the file, or chat prose without a delivery
receipt cannot enter `waiting_acceptance`. For an explicit non-product waiver,
generate before merge and deliver no later than the final response.

## Cost and automation audit

Check specifically for:

- repeated source or issue reads despite an unchanged resume checkpoint;
- full suites run where focused tests were sufficient;
- repeated full review instead of an exact delta review;
- repeated CI or Acceptance polling without state change;
- large raw logs copied into context instead of stored and summarized;
- identical result tables rebuilt in the ledger, report, and chat;
- stable manual state reconstruction, CI classification, evidence capture,
  report assembly, or remote filtering that should become a script.

Report both the observed cost and the prevention. When the environment does not
expose exact token usage, say `unavailable`; never estimate it. Apply only a
narrow blocking workflow correction to the active PR. Route non-blocking
workflow expansion through the budget gate and list the follow-up boundary.

## Post-merge finalization

After human acceptance or an exact-head waiver:

1. Merge the exact decision head and refresh the remote PR merge SHA.
2. Verify every intended GitHub issue is `CLOSED` and its Project item is `Done`.
3. Generate `.records/go/<run-id>/finalization.json` containing the decision
   head, merge SHA, PR number, issue evidence, verification time, delivery
   receipt, and non-empty Workflow/automation response summaries.
4. Deliver a short final receipt using the generated command output. Include
   both `Workflow 改进` and `自动化候选`, including their explicit none entries.
   Reuse the handoff report; do not regenerate the expensive audit.
5. Record both delivery timestamps, then run `state.ts resource-audit`. Reclaim only candidates
   whose PID/process identity and exact worktree or run path prove current-Go ownership. Rerun the
   audit with the recovered categories until it records `clean` or `recovered`; an unverified
   candidate remains fail-closed.
6. Validate persisted checksums/JSON and the resource-cleanup receipt, then transition directly to
   `complete`. Any intervening mutating command invalidates the resource audit.

The final response highlights the merged PR, merge SHA, closed issues, whether
Acceptance was accepted or explicitly waived, the persisted Workflow
improvements, automation candidates, resource cleanup result, and any remaining boundary. It must not
expose local artifact paths, internal session ids, presigned URLs, or raw remote
responses.

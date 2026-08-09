# Final Execution Report and Self-Improvement

Write the final report in Simplified Chinese. Keep code, identifiers, commit
subjects, PR content, and GitHub issue content in English per project rules.

## Required sections

1. **Outcome** — merged PR, final SHA, closed issues, and stable Acceptance URL.
2. **Issue delivery map** — each issue, its user-visible result, commits, and
   focused validation.
3. **Review and Acceptance** — light-review repairs, aggregate deep-review
   findings, immutable Acceptance rounds, rejects, and the final human decision.
4. **Technical debt** — durable product or architecture debt discovered, with
   created follow-up issues or a clear reason no issue was filed.
5. **Workflow evolution** — project skill, `AGENTS.md`, or Acceptance-adapter
   changes applied during the run plus larger recommendations not applied.
6. **Token efficiency** — repeated discovery, duplicate verification, excessive
   polling, oversized context loads, or report duplication observed, and the
   concrete rule or script that would reduce it.
7. **Remaining boundaries** — known exclusions, pending deployment/release, or
   evidence the run did not claim.

Reference GitHub objects with the repository-qualified markdown form required by
`AGENTS.md`.

## Admit workflow learnings carefully

Record a permanent rule only when it is:

- durable across later features;
- project-specific, otherwise suitable for an upstream proposal;
- expressed as an invariant rather than a frozen implementation detail;
- non-duplicative after searching existing instructions;
- actionable for a future agent.

Merge a learning into an existing rule when possible. Route product behavior to
tests or specifications, exact UI values to design/code, and one-off incident
detail to the report. Do not append human feedback verbatim as policy.

Apply obvious narrow project-local fixes directly while the PR is still under
review. Do not alter an already human-accepted head merely to polish agent
instructions; record that improvement for a separate follow-up instead.

## Token-efficiency audit

Check specifically for:

- source or issue state repeatedly reread despite an unchanged checkpoint;
- full suites run where focused tests were sufficient;
- final Acceptance evidence captured before aggregate repairs made it stale;
- identical case tables duplicated between `result.json`, `report.md`, and chat;
- repeated CI or Acceptance polling without state change;
- generic multi-surface documentation loaded for this desktop-only project;
- large raw logs copied into context instead of stored as artifacts and
  summarized.

Report both the observed waste and the implemented or proposed prevention.

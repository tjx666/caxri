# Final Execution Report and Self-Improvement

Write the final report in Simplified Chinese. Keep code, identifiers, commit
subjects, and PR content in English. GitHub issue titles, bodies, and comments
use Simplified Chinese per project rules.

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
6. **Token efficiency and automation candidates** — repeated discovery,
   duplicate verification, excessive polling, oversized context loads, or
   report duplication observed; repeated judgment-free steps that should become
   scripts; and the concrete prevention for both audits.
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
Every Go report must include this audit even when the conclusion is that no
material waste occurred.

## Automation-candidate audit

For every Go run, list repeated manual sequences that consumed judgment-free
tool calls: state reconstruction, CI classification, evidence capture, native
dialog handling, media inspection, report assembly, or remote-state filtering.
Convert a stable, project-local sequence into a tested skill script when the
same code or command choreography was written twice. Otherwise record the exact
script boundary and why it was deferred.

Keep discovery output bounded while doing this audit:

- request only required `gh --json` fields and filter with `--jq`;
- filter LobeHub Acceptance JSON to ids, decisions, checks, and report summaries;
  never emit evidence `fileUrl` values or presigned query strings;
- use compact ledger `resume --json` instead of full `show` unless auditing;
- search before reading, then open only the relevant ranges or referenced files;
- save large logs as artifacts and return a short actionable summary.

---
name: audit-architecture-debt
description: Audit Caxri's current implementation for technical debt, architecture drift, layering and directory-taxonomy problems, weak extension points, lifecycle or concurrency hazards, stale practices, and AI-coding friction. Coordinate context-isolated subagent discovery, independent falsification, and root-agent synthesis for broad audits when collaboration tools are available. Use for repository-wide architecture reviews, "find similar problems" sweeps, modernization scans, module-organization reviews, technical-debt prioritization, or before a large refactor; also use to decide whether a suspicious pattern is intentional, already fixed, or real debt.
---

# Audit Caxri Architecture Debt

Perform an evidence-first, read-only audit of the current repository. Treat past reviews and local
Agent sessions as leads, never as proof that a finding still exists.

## Load the audit references

- Read [references/audit-dimensions.md](references/audit-dimensions.md) before every
  repository-wide audit or request to find similar problems.
- Read [references/subagent-workflow.md](references/subagent-workflow.md) for every broad audit,
  every explicit subagent request, and every focused audit that uses independent reviewers.
- Read [references/report-format.md](references/report-format.md) before producing the final
  report.
- Read [references/debt-ledger.md](references/debt-ledger.md) whenever
  `docs/architecture-debt.md` exists or the user asks to persist findings across runs.
- Call the Skill tool with "project-architecture" before judging an implementation boundary and
  read its relevant reference. That skill describes intended architecture; this skill tests
  whether the current implementation honors it and whether the intent itself creates debt.
- Call the Skill tool with "performance" for measurements. Call the Skill tool with "debug" for a
  concrete failure path. Call the Skill tool with "competitors" for a design problem already
  solved by peer products. Call the Skill tool with "quality-check" only after an explicitly
  authorized implementation.

## Preserve the investigation boundary

- Keep an audit read-only unless the user explicitly asks for fixes.
- Inspect `git status` first. Preserve user-owned changes and do not format, install dependencies,
  generate builds, or create repository artifacts during a read-only audit. Sole exception: when
  the user explicitly asks to persist findings, write only the debt ledger per
  `references/debt-ledger.md`. The worktree may keep changing while the audit runs; judge code as
  it exists on disk, and revalidate cited line numbers against the current tree instead of
  treating drift as an anomaly.
- Exclude generated dependencies, bundles, release artifacts, logs, and lockfile internals unless
  the question specifically concerns them.

### When fixes are authorized

- Separate confirmed findings from implementation work and add a behavior-level regression for
  each bug.
- Dispatch implementation subagents in waves of file-disjoint tasks; never let two concurrent
  tasks edit the same file. Sequence a task that depends on another task's output after that task
  completes.
- Give every implementation subagent the same hard rules: never run
  `git checkout/restore/stash/commit`; make surgical, additive edits in any file carrying
  unrelated uncommitted changes; validate with focused commands only (`bun run check <files>`,
  focused Vitest), never a full suite.
- The root agent reviews each wave's diff before dispatching the next wave, and runs `knip` once
  at the end when renderer or shared-contract files changed.
- Keep large refactors that need their own design (event-model changes, migration frameworks,
  dependency swaps) out of the batch; report them as scoped follow-ups instead of improvising them
  mid-fix.

Do not substitute this skill for `deep-review`. Call the Skill tool with "deep-review" for a
diff, commit, branch, or PR and its merge/release readiness. Use this skill for the current
system's structural sustainability, including legacy debt, contract drift, modernization
opportunities, intentional tradeoffs, and historical revalidation.

## Workflow

### 1. Establish the current baseline

Record the current commit, branch, worktree state, and requested scope. Distinguish among:

- the complete tracked implementation;
- current changes plus their consumers;
- one architecture domain;
- a historical finding that needs revalidation.

Read `AGENTS.md`, `DESIGN.md`, the relevant architecture references, the owning source, and nearby
tests. Use `git ls-files`, `rg --files`, and a shallow directory map to inventory the repository
before drawing conclusions.

When the user asks for historical context, inspect this checkout's local agent records: Claude Code
under `~/.claude/projects/<checkout path with / replaced by ->/` and Grok Build under
`~/.grok/sessions/<URL-encoded checkout path>/`.
Include detached or temporary review sessions only when their prompt or metadata identifies Caxri.
Extract prompts and final results selectively; do not load whole transcripts. Recheck every
historical claim against the current tree.

When `docs/architecture-debt.md` exists, follow the repeat-run workflow in
`references/debt-ledger.md`: revalidate its entries as unverified leads before the new-debt sweep,
and report still-present, resolved, and new findings as separate groups.

When the user supplies an audit report produced outside this session (another agent, another CLI,
or an older report), treat every item in it as an unverified lead, exactly like a historical
claim: re-verify its cited paths and line numbers against the current tree before accepting it,
and do not inherit its category or severity labels: an external "confirmed defect" that fails
re-verification is reclassified, not repeated. Spot-check its highest-severity claims first, then
merge surviving items with this audit's own findings and deduplicate by root cause before
reporting or fixing anything.

### 2. Choose the execution mode

- For a broad or repository-wide audit, use the complete queue in
  `references/subagent-workflow.md`. The root agent owns scope, required reference reading,
  scheduling, verification conflicts, deduplication, prioritization, and the final report.
- For a focused audit, assign one subagent to the named ownership path and a different subagent to
  sweep the same mechanism and adjacent boundaries. Send every reportable candidate to a fresh
  verifier. If discovery finds nothing, use a coverage challenger before declaring the area clean.
- Treat spawned roles as immutable: never turn a completed discovery reviewer into a verifier or
  coverage challenger with a follow-up task. Confirm that every disposition came from a newly
  spawned agent identity before calling it independent.
- Give every subagent a self-contained prompt with isolated context. Do not leak the root agent's
  suspicions, historical conclusions, another reviewer's findings, or expected severity into
  discovery prompts.
- Keep all subagents read-only and prevent nested delegation. Queue work when slots are full;
  never merge or drop an audit group merely to fit the concurrency limit.
- If collaboration tools are unavailable, state that independent coverage could not run. Do not
  describe a single-agent repository-wide scan as a fully independent audit.

### 3. Build an ownership map

Trace the relevant behavior across:

```text
user action
  -> Renderer state or query
  -> typed Preload request
  -> Main or Runtime owner
  -> native process, database, filesystem, Git, or Agent boundary
  -> event and recovery path back to the Renderer
```

Map persistence, cleanup, cancellation, retries, and tests alongside the happy path. A directory
name or abstraction is not enough evidence; verify the runtime owner and real consumers.

### 4. Sweep every dimension

Use every dimension in `references/audit-dimensions.md`. User examples establish a minimum, not
the audit boundary. A request such as "find similar issues" requires checking neighboring
dimensions such as naming, taxonomy, ownership, extension points, state flow, duplication,
lifecycle, tests, and documentation drift. Assign each dimension to exactly one primary reviewer
and use handoffs, not duplicate findings, when a causal trace crosses groups.

Record a short "checked, clean" result for dimensions with no finding. This makes omitted coverage
visible and prevents one strong example from narrowing the whole audit.

### 5. Prove or downgrade each candidate

For every candidate:

1. State the user-visible or developer-visible failure/friction scenario.
2. Trace the causal path through current files and line numbers.
3. Identify the violated contract, repeated change cost, risk, or measurable waste.
4. Inspect tests, logs, benchmarks, or a safe temporary probe that could falsify the claim.
5. Check whether a later commit already resolved the issue.

Do not call something debt merely because another framework uses a different convention. Verify
current official documentation before making time-sensitive claims about dependencies, Electron,
React, TypeScript, Vite, or recommended ecosystem practices. Prefer primary sources.

For subagent-backed audits, require a verifier other than the discovering reviewer to search for
current guards, cleanup, bounds, tests, alternative owners, later fixes, and intentional product
constraints. Resolve reviewer/verifier disagreement personally. Keep anything still uncertain under
open hypotheses instead of the findings list.

### 6. Classify findings precisely

Use one category per item:

- **Confirmed defect**: a current behavior can fail, corrupt state, leak authority, or violate a
  tested contract.
- **Architecture debt**: the current structure creates repeated cross-cutting edits, unclear
  ownership, unsafe coupling, or rising change cost.
- **Contract drift**: documentation, schema, tests, or UI promises disagree with runtime behavior.
- **Modernization opportunity**: a verified current alternative offers concrete value, but the
  present choice is still valid.
- **Coverage or observability gap**: a risky behavior lacks a way to detect regressions; do not
  present it as a confirmed bug.
- **Intentional tradeoff**: the behavior is explicit, bounded, and supported by the product model.
  Report it separately, not as debt.
- **Resolved or stale**: historical evidence no longer matches the current implementation.

Keep hypotheses out of the findings list until they meet an evidence threshold.

### 7. Prioritize by consequence and leverage

Order findings by:

1. data loss, authority expansion, crash, or unrecoverable user impact;
2. cross-process lifecycle and state-consistency risk;
3. repeated change cost across several consumers;
4. measured performance or resource cost;
5. local discoverability and naming friction;
6. optional ecosystem modernization.

Do not prioritize by line count, novelty, or aesthetic preference alone. Recommend the smallest
architectural move that removes the cause and state the acceptance boundary; do not turn the
report into an unapproved rewrite plan.

### 8. Report the current truth

Follow `references/report-format.md`. Lead with the overall conclusion and top themes. Put findings
before broad commentary, cite exact current files and lines, and keep confirmed facts distinct
from inference and access limits.

End with:

- a coverage matrix for every audit dimension;
- intentional tradeoffs that should remain unchanged;
- stale historical concerns that were rechecked;
- subagent discovery, verification, false-positive, and missing-coverage counts;
- validation performed and validation not performed.

Stop when every dimension has a recorded result, the coverage challenger has run for a broad
audit, every reportable finding has independent disposition, and the root agent has rechecked the
current lines and baseline. Do not keep scanning solely to manufacture more findings.

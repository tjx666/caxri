# Subagent audit workflow

## Contents

- [Runtime contract](#runtime-contract)
- [Execution modes](#execution-modes)
- [Baseline packet](#baseline-packet)
- [Broad audit groups](#broad-audit-groups)
- [Discovery protocol](#discovery-protocol)
- [Independent falsification](#independent-falsification)
- [Coverage challenge and synthesis](#coverage-challenge-and-synthesis)

## Runtime contract

Use context-isolated collaboration subagents. Spawn with `fork_turns: "none"`; do not override the model unless the user or runtime requires it. The root agent keeps control of scope, scheduling, source-of-truth reading, conflict resolution, prioritization, and final prose.

All subagents must:

- stay read-only and avoid builds, formatting, installs, generated artifacts, commits, and external mutations;
- report the starting and ending HEAD plus worktree state;
- avoid nested delegation;
- return structured output, not a final user report;
- stop at the assigned evidence boundary and return cross-group leads through `handoff_to`.

With the normal four-slot limit, keep at most three subagents active. Queue every remaining group and verifier; never combine responsibilities or drop coverage to fit the limit.

Treat each spawned agent identity as role-immutable for the entire audit. A discovery reviewer must never become a verifier or coverage challenger through a follow-up task, even after it reports completion. Verification requires a newly spawned canonical task with no discovery turns in its context. Before accepting a disposition, the root agent must confirm from the agent tree that its author is different from every reviewer that produced the candidate; otherwise discard the disposition and rerun it with a fresh agent.

## Execution modes

### Broad audit

Run all four discovery groups. Start the first three concurrently and queue `interaction-toolchain`. Launch every discovery group before spending a released slot on verification. After discovery, run independent verification and one coverage challenger.

### Focused audit

Run two independent discovery roles:

1. an ownership-path reviewer that traces the named behavior end to end;
2. a pattern reviewer that searches for the same mechanism, repeated edit sites, and adjacent dimensions elsewhere.

Use a fresh verifier for candidate findings. If both reviewers find nothing, run a coverage challenger that tries to identify an omitted owner, consumer, state boundary, or lifecycle transition.

### Historical context

Mine local Claude Code or Grok Build records only after current-tree discovery. Give the history miner the topic and session locations, not current reviewer conclusions. Its output is a list of sourced historical leads with their old commit/context; every lead requires current-source verification before classification.

## Baseline packet

The root agent must read `AGENTS.md`, `DESIGN.md`, the audit references, and relevant `project-architecture` sources itself. Build one neutral packet for all reviewers containing:

- HEAD SHA, branch, and exact worktree status;
- requested scope and explicit exclusions;
- shallow tracked-file/directory inventory;
- assigned dimensions and their reference paths;
- relevant source, consumer, test, and architecture paths;
- read-only rules and the output contract below.

Use the decision table in [project-architecture](../../project-architecture/SKILL.md) to select
each reviewer's architecture references. The architecture index is a map, not a requirement to
read every linked file. Send paths and relevant section/search hints, not the same full document
body to every reviewer. Start with these group-specific topics and follow additional contracts
only when a causal path requires them:

| Group                   | Initial architecture topics                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `product-boundaries`    | `product-model.md`, `process-model.md`, `ipc.md`, `security.md`                                      |
| `structure-extension`   | `packages.md`, `ipc.md`, `cli.md`, `diagnostics.md`                                                  |
| `state-runtime`         | `persistence.md`, `terminal-lifecycle.md`, `process-model.md`, `performance.md`                      |
| `interaction-toolchain` | `editor-and-search.md`, `terminal-interaction.md`, `settings-and-themes.md`, `electron-toolchain.md` |

These filenames are relative to `project-architecture/references/`. Root synthesis reads the
contracts needed to adjudicate findings; it does not repeat every reviewer's baseline read.

Do not include suspected findings, historical conclusions, another agent's output, expected category/severity, or preferred remediation. Tell reviewers the worktree may keep changing while they work: judge code as it exists on disk, record their own start and end `git status`, and report drift only when it affects cited evidence, not as an anomaly in itself. If the worktree changes during the audit, the root agent identifies affected paths and revalidates their evidence instead of silently mixing baselines.

## Broad audit groups

| Group                   | Primary dimensions                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `product-boundaries`    | Product and contract alignment; Process and capability ownership; Security and privacy                                   |
| `structure-extension`   | Domain boundaries and directory taxonomy; Extension and composition points; Tests, observability, and AI operability     |
| `state-runtime`         | State, cache, and data flow; Persistence and migrations; Lifecycle, concurrency, and recovery; Performance and resources |
| `interaction-toolchain` | UI and interaction architecture; Toolchain and ecosystem fit                                                             |

A reviewer may follow a causal path into a neighboring group, but only the primary owner emits that dimension's candidate. Send the other reviewer a neutral `handoff_to` lead. This prevents the same symptom from becoming several findings while preserving end-to-end tracing.

## Discovery protocol

Require a breadth pass before deep investigation:

1. Inventory the owner, consumers, state, cleanup, and tests for every assigned dimension.
2. Record `checked_clean` with an evidence boundary when no candidate qualifies.
3. Deepen only candidates with a concrete current scenario and structural-debt test.
4. Search for counterevidence before returning a candidate.

Return exactly one JSON object with this shape:

```json
{
  "baseline": { "head": "<sha>", "worktree": "<status summary>" },
  "coverage": [
    {
      "dimension": "<assigned dimension>",
      "result": "candidate | checked_clean | out_of_scope",
      "candidate_ids": [],
      "paths_checked": [],
      "evidence_boundary": "<what current evidence proves>",
      "unverified_boundary": "<what was not proved>"
    }
  ],
  "candidates": [
    {
      "id": "<group>-1",
      "primary_dimension": "<dimension>",
      "related_dimensions": [],
      "proposed_category": "<audit category>",
      "impact": "critical | high | medium | low",
      "leverage": "cross_cutting | multi_module | local",
      "claim": "<current claim>",
      "context": "<why the owner matters>",
      "scenario": "<concrete sequence>",
      "contract": { "source": "<path:line>", "invariant": "<expected behavior>" },
      "causal_trace": [{ "location": "<path:line>", "role": "<cause or consumer>" }],
      "current_consumers": [],
      "counterevidence": [],
      "structural_debt_test": "<why this is debt now>",
      "falsification_question": "<neutral question>",
      "disconfirming_observation": "<what would refute it>",
      "remediation_target": "<smallest outcome>",
      "acceptance_boundary": "<observable proof>",
      "handoff_to": [],
      "access_limits": []
    }
  ],
  "intentional_tradeoffs": [],
  "historical_leads": [],
  "missing_sources": []
}
```

Require every assigned dimension exactly once in `coverage` and unique candidate IDs. Retry malformed or incomplete output once with the exact problem; after a second failure, record missing coverage rather than interpreting free-form prose.

Keep the handoff compact: use the minimum evidence needed to reconstruct and falsify each claim. A focused reviewer returns at most five candidates unless it finds an additional critical-impact issue; overflow becomes a neutral `handoff_to` lead for a queued pass.

## Independent falsification

Never let a discovering reviewer verify its own candidate, and never reuse any discovery agent as a verifier for another reviewer's candidate. Spawn a new verifier task after discovery has completed. For the first pass, give it only the neutral scenario, invariant, and falsification question. Hide the original location, classification, impact, history, remediation, discovery transcript, and reviewer identity so the verifier must independently reconstruct the real owner, guards, cleanup, bounds, consumers, and tests.

After the blind reconstruction, provide the original candidate and ask the same verifier to compare evidence. Require one final disposition per ID:

- `confirmed`;
- `false_positive`;
- `downgraded_to_gap`;
- `intentional_tradeoff`;
- `resolved_or_stale`;
- `need_more_context`;
- `duplicate_root_cause`.

The verifier may override category, impact, leverage, remediation target, and acceptance boundary, but must cite current `path:line` evidence. Unresolved runtime or external facts stay under open hypotheses. The root agent personally re-traces disagreements and every critical/high-impact item.

## Coverage challenge and synthesis

For a broad audit, send a fresh coverage challenger the baseline, the coverage records, and the aggregated `unverified_boundary` and `missing_sources` entries from every discovery group, never the findings themselves. Those stated boundaries are where discovery already admitted it did not look; they are the challenger's highest-yield targets. Also hand it a concrete probe list of recurring blind spots that sit between the group assignments: preload event routing, Renderer error boundaries and render-failure recovery, terminal snapshot/replay ordering, theme and settings import parsing, Process Explorer channels, `scripts/` tooling, git hooks, and the knip/doctor configs. Require it to actually open each probed file and return either a `path:line` lead with a one-sentence hypothesis or an explicit "probed, clean"; a lead list without probes is not a coverage challenge.

Verify any new lead through the normal independent flow with a fresh verifier per lead.

Deduplicate only after verification. Merge findings only when they share the same violated invariant, owner, failure transition, and acceptance boundary, so one concrete remediation removes all mapped symptoms. Similar files, processes, or topics are insufficient.

The root agent writes the final report. Before rendering it:

- recheck HEAD, worktree changes, every cited line, and the highest-impact causal paths;
- include only independently confirmed findings and clearly labeled objective gaps;
- keep intentional tradeoffs, open hypotheses, and historical revalidation separate;
- record reviewer groups, candidate count, false positives, unresolved items, and missing coverage in the validation boundary.

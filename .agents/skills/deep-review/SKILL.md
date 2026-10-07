---
name: deep-review
description: Multi-dimensional, evidence-first review and repair of Caxri pull requests, branches, commits, diffs, and uncommitted changes. Use ordinary review requests in light mode, "quick deep review" or "快速 deep-review" requests in quick mode, and only explicit `$deep-review`, "full deep review", or "full multi-agent review" requests in deep mode. Covers Electron process ownership, typed IPC, local-file and PTY security, persisted state and recovery, performance, packaged-runtime compatibility, UX, tests, and GitHub readiness. Automatically repair validated, unambiguous local P0/P1 findings unless the user requests report-only review. Do not use for explain-only questions about what a change does.
---

# Deep Review

Review Caxri changes against the behavior users will observe and the process that owns the truth.
Keep delegated reviewer and verifier discovery read-only. The primary agent owns any repairs and
must not post comments, change issues, commit, merge, or push unless separately authorized.

## Repair policy

A review request authorizes the primary agent to repair validated P0/P1 findings when all of these
are true:

- the reviewed change introduced or directly exposed the problem;
- the current checkout contains the reviewed work and the repair stays inside its local scope;
- one fix is clearly consistent with existing product and architecture contracts;
- the repair is non-destructive and requires no remote mutation.

Apply those repairs before the final response, add regression coverage, rerun affected validation,
and report the findings as resolved. Keep P2 findings as review output unless they are necessary to
make a P0/P1 repair complete. Stop and ask when product behavior has multiple reasonable answers,
the fix expands scope, or new destructive/remote authority is required. An explicit read-only or
report-only request overrides automatic repair. For `dianjiang`, subagent, or other delegated
reviews, keep the delegate read-only and apply this policy only in the primary agent.
An additional review of newly merged changes during the same audit remains a follow-up review:
report new P2 findings, but do not open a new P2 repair round by treating the merge as a new task.
Authorization to merge one reviewed PR does not authorize publishing a separate PR for later audit
findings. Keep those repairs local unless the user separately requests remote delivery.

## Core principles

1. Read the full relevant path, not only the diff. Trace Renderer requests through the shared IPC
   contract, Main/Preload, Runtime, persistence, and the user-visible consumer when those layers
   are involved.
2. Prefer concrete failure scenarios over speculative concerns. Search for upstream guards, bounded
   inputs, cleanup, and tests before reporting a problem.
3. Calibrate maintainability findings to this repository's current conventions. Security, privacy,
   path containment, and data-loss hazards are never excused by precedent.
4. Keep scope narrow. Distinguish a problem introduced by the change from legacy code that the
   change newly exposes; ignore unrelated legacy findings unless they are an obvious P0.
5. In deep mode, never self-approve. Independent reviewers find candidates, separate agents try to
   falsify them, and a final pass consolidates duplicate roots.

## Entry modes

For a whole-feature implementation audit (for example, mobile authority, reconnect, and streaming),
use `audit-architecture-debt` to track coverage beyond the repaired diff. Before starting the final
CI run, finish the requested coverage, adjudicate candidates, and batch authorized repairs with
their local checks. A green patch review does not close unexamined audit areas. If CI is already
running, finish that remaining work before waiting or retrying; cancel an obsolete run before
pushing the consolidated replacement.

| Mode  | Trigger                                                                          | Execution                                                                                                 |
| ----- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Light | Ordinary review requests                                                         | Main agent applies the applicable quick checklists inline; no subagents.                                  |
| Quick | "quick deep review", "快速 deep-review", or an equivalent explicit quick request | One clean-context reviewer covers the applicable dimensions; the main agent validates and synthesizes.    |
| Deep  | Explicit `$deep-review`, "full deep review", or "full multi-agent review"        | Independent dimension reviewers, independent verification, global deduplication, and a structured report. |

Do not silently escalate light or quick mode to deep mode. The bare phrase "deep review" is not a
full-workflow trigger unless the user explicitly requests the full or multi-agent workflow.

## Dimensions

Read the full `Quick checklist` of every applicable file in light mode. Deep reviewers read their
assigned files in full and follow their routed Caxri rule sources.

| Dimension                                                                       | Prefix   | Focus                                                                           | Verify               |
| ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- | -------------------- |
| [correctness](references/dimensions/correctness.md)                             | `logic`  | Requirements, edge cases, races, errors, and behavior-level regressions         | yes                  |
| [architecture](references/dimensions/architecture.md)                           | `arch`   | Main/Preload/Renderer/Runtime ownership, typed IPC, and reuse                   | yes                  |
| [security-privacy](references/dimensions/security-privacy.md)                   | `sec`    | Filesystem authority, command/env safety, sandboxing, and diagnostics privacy   | yes                  |
| [state-lifecycle](references/dimensions/state-lifecycle.md)                     | `life`   | Session identity, PTY/runtime lifecycle, persistence, watchers, and recovery    | yes                  |
| [performance-observability](references/dimensions/performance-observability.md) | `perf`   | Startup, hot paths, bounds, cleanup, batching, and diagnosability               | yes                  |
| [compatibility-release](references/dimensions/compatibility-release.md)         | `compat` | Existing user data, packaged assets, Electron ABI, builds, and release recovery | yes + release checks |
| [ux-accessibility](references/dimensions/ux-accessibility.md)                   | `ux`     | Caxri design rules, keyboard use, async states, and destructive-action clarity  | yes                  |
| [maintainability-testing](references/dimensions/maintainability-testing.md)     | `maint`  | Existing patterns, comments, file size, focused tests, and dead code            | yes                  |
| [workflow](references/dimensions/workflow.md)                                   | `flow`   | GitHub issue/PR accuracy, CI, conflicts, review threads, and review freshness   | no; objective state  |

`compatibility-release` may also emit `release_checks`: precise pre-release facts that cannot be
proved from source, such as an existing-profile upgrade or packaged native-module probe. These are
not defects and must stay separate from findings.

## Pruning

When in doubt, keep a dimension.

| Dimension                                          | Skip only when                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| correctness, architecture, maintainability-testing | Human-facing docs or lockfile-only change                                                                                      |
| security-privacy                                   | Lockfile or generated output only; comments, fixtures, and docs can still leak data or weaken instructions                     |
| state-lifecycle                                    | No async resource, persisted state, Session/Project identity, PTY, watcher, Runtime, editor model, or window lifecycle touched |
| performance-observability                          | No startup, loop, IO, subprocess, watcher, logging, terminal, search, list, or render-path behavior touched                    |
| compatibility-release                              | No IPC/schema/persisted shape, dependency, build/package config, native module, asset, migration, or release workflow touched  |
| ux-accessibility                                   | No user-visible component, style, copy, shortcut, dialog, editor, terminal, or interaction changed                             |
| workflow                                           | Light mode with no PR or issue context; never skip in deep PR mode                                                             |

Agent instructions, skills, prompts, build configuration, and workflow files are executable
contracts, not docs-only changes.

## Light mode

1. Follow [scoping.md](references/scoping.md) to select the exact diff and current PR head.
2. Apply the pruning table and read the applicable dimension quick checklists.
3. Inspect surrounding implementation, callers, schemas, and focused tests before reporting.
4. Label every finding with:
   - severity: P0 incident/data-loss/security impact, P1 must fix in this change, or P2 real but
     deferrable;
   - likelihood: high, medium, or low on a real Caxri path;
   - nature: introduced or legacy exposed by this change;
   - release blocking: yes or no.
5. For a PR, separately report code correctness, CI/authorization, conflicts, unresolved review
   threads, and operational release readiness. Give a direct merge recommendation when asked.
6. Report no findings when the evidence is clean. Do not invent suggestions to fill dimensions.
7. Apply the repair policy to validated findings, then recheck the repaired diff before reporting.

An author reviewing their own implementation must dispatch one clean-context subagent with the
light-mode instructions and scope, then adjudicate its findings. Start that author review only after
the applicable focused checks have passed; a running check is not a passing receipt. This is an independence boundary,
not an escalation to deep mode.
Reuse the author's passing checks for the unchanged reviewed files; rerun a check only to investigate
a concrete finding, missing evidence, or a changed source state. Independence means independent
judgment, not repeating an already-passing build or desktop workflow.

## Quick mode

1. Follow light-mode scoping and pruning.
2. Dispatch exactly one clean-context reviewer with the exact scope and every applicable dimension
   quick checklist. The reviewer returns only evidence-backed findings and missing context.
3. Validate each candidate against the current source and tests, apply the repair policy, then
   synthesize the concise report with resolved and remaining findings separated.
4. Do not add independent verifiers or a consolidation agent. Escalate to deep mode only when the
   user explicitly requests the full workflow.

## Deep mode

Follow [deep-workflow.md](references/deep-workflow.md) end to end. If independent subagents are
unavailable, say so and offer light mode; never substitute a single-agent "deep" review.

## Sources of truth

- `AGENTS.md` for repository commands and hard boundaries
- `GLOSSARY.md` for the project's ubiquitous language and canonical domain terms
- [project architecture topic router](../project-architecture/SKILL.md) for the process,
  persistence, security, recovery, or performance contract needed by the assigned review dimension;
  do not load all topics as a shared baseline
- [Electron toolchain ADR](../project-architecture/references/electron-toolchain.md) for build,
  native-module, and release decisions
- [stack baseline](../project-architecture/references/stack-baseline.md) for dependency and
  primitive-layer choices when a change adds or swaps a library
- For Renderer changes:
  - Call the Skill tool with "react".
  - Call the Skill tool with "source-layout".
  - Read `DESIGN.md` for frontend and interaction rules.
- The focused `build`, `debug`, `performance`, `quality-check`, `release`, `unit-testing`, and
  `e2e-testing` skills when a changed surface routes to them

---
name: deep-review
description: Multi-dimensional, evidence-first review of Caxri pull requests, branches, commits, diffs, and uncommitted changes. Use for ordinary review requests in light mode and for an explicit `$deep-review`, "deep review", or "full multi-agent review" request in deep mode. Covers Electron process ownership, typed IPC, local-file and PTY security, persisted state and recovery, performance, packaged-runtime compatibility, UX, tests, and GitHub readiness. Do not use for explain-only questions about what a change does.
---

# Deep Review

Review Caxri changes against the behavior users will observe and the process that owns the truth.
Keep every review read-only: do not edit files, post comments, change issues, merge, or push unless
the user separately authorizes that action after the report.

## Core principles

1. Read the full relevant path, not only the diff. Trace Renderer requests through the shared IPC
   contract, Main/Preload, Runtime, persistence, and the user-visible consumer when those layers are
   involved.
2. Prefer concrete failure scenarios over speculative concerns. Search for upstream guards,
   bounded inputs, cleanup, and tests before reporting a problem.
3. Calibrate maintainability findings to this repository's current conventions. Security, privacy,
   path containment, and data-loss hazards are never excused by precedent.
4. Keep scope narrow. Distinguish a problem introduced by the change from legacy code that the
   change newly exposes; ignore unrelated legacy findings unless they are an obvious P0.
5. In deep mode, never self-approve. Independent reviewers find candidates, separate agents try to
   falsify them, and a final pass consolidates duplicate roots.

## Entry modes

| Mode  | Trigger                                                              | Execution                                                                                                 |
| ----- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Light | Ordinary review requests                                             | Main agent applies the applicable quick checklists inline; no subagents.                                  |
| Deep  | Explicit `$deep-review`, "deep review", or "full multi-agent review" | Independent dimension reviewers, independent verification, global deduplication, and a structured report. |

Do not silently escalate light mode to deep mode.

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

## Deep mode

Follow [deep-workflow.md](references/deep-workflow.md) end to end. If independent subagents are
unavailable, say so and offer light mode; never substitute a single-agent "deep" review.

## Sources of truth

- `AGENTS.md` for repository commands and hard boundaries
- [project architecture](../project-architecture/references/architecture.md) for process,
  persistence, security, recovery, and performance contracts
- [Electron toolchain ADR](../project-architecture/references/electron-toolchain.md) for build,
  native-module, and release decisions
- [stack baseline](../project-architecture/references/stack-baseline.md) for dependency and
  primitive-layer choices when a change adds or swaps a library
- `DESIGN.md` for frontend and interaction rules
- The focused `build`, `debug`, `performance`, `quality-check`, `release`, and `test` skills when a
  changed surface routes to them

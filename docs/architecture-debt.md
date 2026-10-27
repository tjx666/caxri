---
kind: living
status: current
---

# Architecture debt ledger

Persistent record of architecture-debt audit findings for revalidation across runs.
Maintained per `.agents/skills/audit-architecture-debt/references/debt-ledger.md`.

| Field                    | Value                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| **First audit**          | 2026-08-11 @ `eb9becbee1f9c77d914fa6d113fa6084dba587b5` (`main`)                                       |
| **Last full audit**      | 2026-10-26 @ `c23b63b9d` (`main`)                                                                      |
| **Targeted review base** | 2026-08-24 @ `87b613a` ([issue caxri#165](https://github.com/tjx666/caxri/issues/165))                 |
| **Full-audit scope**     | Every prior OPEN entry plus all dimensions over the complete tracked tree at `c23b63b9d`               |
| **Maintenance**          | Revalidate after ownership/path refactors and at least quarterly; refresh semantic evidence, not paths |

Targeted maintenance corrects affected evidence and records reviewed tradeoffs; it does not move
the full-audit watermark or imply a repository-wide debt sweep. Quarterly or ownership-refactor
revalidation may inspect workflow clauses, contract tests, and guard scripts for current owners,
consumers, and trigger evidence. Record “checked, no change” when appropriate; absence of failures
alone does not prove a guard is stale, and a separate reverse-knip job or ceremony requires a
concrete failure mode.

Statuses: `OPEN` · `RESOLVED` · `STALE`. Effort: S / M / L per the audit report format.
Category labels match the audit skill: Confirmed defect, Architecture debt, Contract drift,
Coverage or observability gap, Modernization opportunity, Intentional tradeoff.

---

## OPEN

Full audit 2026-10-21 @ `d0e5f01fc` revalidated every prior entry. The fix batch in [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264)
resolved most of them, and the fix batch of [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332) resolved the later audit's findings; the entries below keep the part that still needs a product decision or its own design.
Full audit 2026-10-26 @ `c23b63b9d` revalidated all seven as still present; its new findings were fixed by the batch of [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601).

### AD-lifecycle-chat-idle-providers: [OPEN · Architecture debt · L]

- **Summary:** Reading a stopped Chat still starts its provider, because model lists, commands, and live state come from the provider rather than from a transcript reader.
- **Evidence:** `apps/server/src/domains/agent-chat/service.ts` `read()` still starts a bound Chat. The ownership half is fixed: a read-started provider holds an observation lease (`apps/server/src/domains/agent-chat/chat-suspension.ts`) that the idle sweep reclaims two minutes after its Session is left, independent of the idle-suspension setting (`apps/server/src/domains/terminal/suspension-policy.ts`), and every provider start, PTY relaunch, and restore passes the 16-per-Session and 32-global capacity gate in `apps/server/src/domains/db/models/terminals.ts`. Covered by `service-lease.integration.test.ts`, `service-capacity.integration.test.ts`, and `terminal-restart-capacity.integration.test.ts`.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-26 @ c23b63b9d (still present)
- **Remediation target / Acceptance:** [issue caxri#1800](https://github.com/tjx666/caxri/issues/1800): a pure read starts no provider. Reclaim is bounded by time and count: only the newest `MAX_CHAT_OBSERVATION_LEASES` read leases wait out the window, and a read that starts a provider sweeps the older ones at once (`terminal/__tests__/suspension-chat.test.ts`). Reclaim races with read, reselection, and input, plus the capacity gate on resume, are covered by `service-lease.integration.test.ts`, `service-capacity.integration.test.ts`, and `suspension-chat.test.ts`.

### AD-layout-flat-family-enforcement: [OPEN · Architecture debt · M]

- **Summary:** Desktop Main (116 direct modules) and the Server `agent-chat` domain (96, with flat `chat-`, `claude-`, `codex-`, and `grok-` families) are still flat; they can no longer grow, but nothing has moved into family directories yet.
- **Evidence:** `scripts/directory-density-baseline.ts` records shrink-only caps for those owners, their prefix families, the Renderer `features/agent-chat` root, and every nested subdirectory below a guarded owner that reaches `DIRECTORY_DENSITY_NESTED_THRESHOLD` (12) files; `scripts/__tests__/directory-density-ratchet.test.ts` fails on growth and on an untightened shrink, and `scripts/run-ci-focused-checks.ts` routes affected and draft pull requests touching those directories to it.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-26 @ c23b63b9d (still present)
- **Recurrence 2026-10-26:** the same flat-family shape grew outside the guarded owners: about 27 `git-*` modules in the Renderer `features/editor` root and 16 `extension-tree-*` modules in `features/view-containers`. Neither directory has a density cap yet.
- **Remediation target / Acceptance:** [issue caxri#1993](https://github.com/tjx666/caxri/issues/1993): pure moves into provider and family directories, tightening the recorded caps as they land. Add caps for the two Renderer families when they move.

### AD-contract-provider-literal-comparisons: [OPEN · Architecture debt · M]

- **Summary:** Provider identity is still compared against string literals in several modules, so adding or renaming a provider needs a repository-wide search instead of one registry edit.
- **Evidence:** About 55 comparison sites, for example `apps/server/src/domains/session/compaction.ts`, `agent-chat/chat-history.ts`, `agent-chat/chat-images.ts`, `agent-runtime/turn-context.ts`, and `agent-benchmark/launch.ts`; hand-written provider ID lists in `packages/protocol/src/agent/delegation/agent-delegation-settings.ts`, `apps/server/src/domains/agents/external-conversation-parsers.ts`, `apps/mobile/src/features/sessions/new-session-model.ts`, and `apps/desktop/src/renderer/src/features/benchmark/benchmark-selection.ts`.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-26 @ c23b63b9d (still present)
- **Remediation target / Acceptance:** [issue caxri#2335](https://github.com/tjx666/caxri/issues/2335): route provider-specific branching through the provider registry or capability flags; a guard fails on new literal comparisons.

### AD-toolchain-electron-45-stable-pin: [OPEN · Modernization opportunity · S]

- **Summary:** Electron is still pinned to `45.0.0-beta.6` although the stack baseline's exit condition (45.0.0 stable, published 2026-10-21) is met and the 24-hour `minimumReleaseAge` has passed. Docs also cite Chromium 155 while the runtime is Chromium 156.
- **Evidence:** `electron` in the root `package.json` and `apps/desktop/package.json`; the `minimumReleaseAge` exclusion in `pnpm-workspace.yaml`; `.agents/skills/project-architecture/references/stack-baseline.md`; `docs/startup-performance.md`.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-26 @ c23b63b9d (still present)
- **Remediation target / Acceptance:** [issue caxri#2333](https://github.com/tjx666/caxri/issues/2333): move to Electron 45 stable once native modules and the packaging checks pass, then update the stack baseline.

### AD-contract-mobile-view-reply-roles: [OPEN · Contract drift · S]

- **Summary:** Mobile pairing defines `view` and `reply` roles, but every new pairing is granted `control` and no API changes a role, so the weaker roles cannot be assigned.
- **Evidence:** `control` is hardcoded in the device registry; the authorization doc now states this (docs corrected in [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332)). The remaining gap is a product decision on role assignment.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-26 @ c23b63b9d (still present)
- **Remediation target / Acceptance:** [issue caxri#2334](https://github.com/tjx666/caxri/issues/2334): decide whether to ship role selection at pairing or remove the unused roles.

### AD-persist-delegation-collected-answers: [OPEN · Architecture debt · S]

- **Summary:** Capacity pruning never evicts completed delegation answers because the store cannot tell whether a caller already read them, so a long-lived profile can still fill the 1,024-record cap with completed tasks and new delegations fail with `CAPACITY`.
- **Evidence:** `pruneForAdmission` in `apps/server/src/domains/db/models/agent-delegations.ts` only removes settled records with no `answer`.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-26 @ c23b63b9d (still present)
- **Remediation target / Acceptance:** [issue caxri#2338](https://github.com/tjx666/caxri/issues/2338): persist a collected marker when an answer is read and let pruning remove collected records oldest first.

### AD-toolchain-knip-entry-exports: [OPEN · Coverage or observability gap · S]

- **Summary:** Knip does not check unused exports from package entry barrels, so dead public exports accumulate unnoticed; nine were found and deleted by hand.
- **Evidence:** Measured with `--include-entry-exports`: 379 additional reports, mostly barrel exports in `packages/protocol`, `packages/mobile-transport`, and `packages/markdown`, plus framework default exports and extension `activate` functions. Many are likely false positives; the config is unchanged.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-26 @ c23b63b9d (still present)
- **Remediation target / Acceptance:** [issue caxri#2337](https://github.com/tjx666/caxri/issues/2337): triage the report with ignore rules for framework entries, then enable `includeEntryExports` when the residue is small.

---

## RESOLVED

### AD-ui-render-crash-session-loop: [RESOLVED · Architecture debt · M]

- **Summary:** When a persisted Session made the Workbench throw on render, Reload restored the same Session from the Server's window record and crashed again, leaving the user no way to reach any other Session.
- **Evidence:** `apps/desktop/src/renderer/src/features/workbench/render-crash-recovery.ts` records render crashes in `sessionStorage` per window; `recovering-snapshot-source.ts` skips the recorded Session on the first snapshot read (after a second crash within a minute, or when the user chose **Reload without this Session**) and selects the next openable Session through `session.select`; `render-crash-commands.ts` wires it through the existing `configureWorkbenchSnapshotSource` seam and the `RendererRoot` boundary in `main.tsx`. Covered by `features/workbench/__tests__/render-crash-recovery.test.ts`.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601). When the crashing Session is the only openable one, the window still lands on it; Terminal and Chat panes still have no pane-level boundary (`IT-window-level-error-boundary`).

### AD-lifecycle-restore-scope-dedupe: [RESOLVED · Confirmed defect · S]

- **Summary:** Clicking Resume Agent while a Session's suspended Shell was still restoring silently dropped the request, so a detached Agent Terminal stayed Detached until a second click.
- **Evidence:** `apps/server/src/domains/terminal/restore-supervisor.ts` accepts `afterActive` for a request whose scope is wider; it waits for the active same-Session restore and then runs, instead of returning an empty result. `restore.ts` plans its operations lazily so the queued request sees the state the first restore left. Covered by `terminal/__tests__/restore-supervisor.test.ts`.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601). An identical plain request is still deduplicated on purpose.

### AD-contract-legacy-store-compat: [RESOLVED · Contract drift · M]

- **Summary:** Two stores still read formats written only by unpublished builds, against the pre-release no-compatibility rule: a v1 mobile device registry silently loaded as empty, so paired phones failed to connect with no hint, and file-operation journal records without `workbenchProjectId` fell back to matching by Session.
- **Evidence:** `apps/server/src/core/mobile/device-registry.ts` rejects a non-v2 store with a `VALIDATION` error naming the reset step, and Server Core startup fails the same way as for a malformed store (`device-registry.test.ts`, `registry-startup.integration.test.ts`, `docs/mobile/authorization.md`). `workbenchProjectId` is required in `packages/protocol/src/domain/domain.ts`; `apps/server/src/domains/files/mutation-journal.ts` lost the Session fallback, and an unreadable journal fails the file operation with a reset hint (`mutation-journal.test.ts`, `files-and-paths.md`).
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601). The built-in snapshot replacement inside theme `upgradeThemeColors` needs a product decision: [issue caxri#2604](https://github.com/tjx666/caxri/issues/2604).

### AD-lifecycle-mobile-observer-orphan: [RESOLVED · Confirmed defect · S]

- **Summary:** When a phone's live-Terminal observe request timed out after the Terminal Host had already registered it, nothing released the observer, so the Host kept copying output to an unread queue until the PTY exited; failed unobserves were swallowed.
- **Evidence:** `apps/server/src/core/mobile/gateway/terminal-observer.ts` sends a best-effort unobserve after a failed start or refresh, and every teardown failure is logged as `mobile_gateway.terminal_teardown_failed` with a closed reason (`packages/protocol/src/domain/logging-mobile-gateway.ts`). Covered by `gateway/__tests__/terminal-observer-teardown.test.ts`.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601).

### AD-docs-preload-surface-drift: [RESOLVED · Contract drift · S]

- **Summary:** The architecture references an agent reads to judge authority listed only three of the seven Preload bridge methods, omitted the `performanceMonitorHost` global and the Benchmark and Performance Monitor windows, and did not mention the env-gated Acceptance fixtures shipped in production Main.
- **Evidence:** `.agents/skills/project-architecture/references/ipc.md`, `process-model.md`, and `security.md` now list them; `apps/desktop/src/preload/__tests__/exposed-globals.test.ts` fails when a global or bridge method changes and points back to `ipc.md`.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601).

### AD-privacy-url-userinfo-redaction: [RESOLVED · Coverage or observability gap · S]

- **Summary:** Log redaction left credentials embedded in a URL (`https://user:token@host`) intact; no current path was found to log one, so this was defense in depth.
- **Evidence:** `packages/utils/src/redaction.ts` strips URL userinfo for `http(s)`, `ssh`, `git`, and `ftp(s)` URLs before the presigned-URL rule; covered by `packages/utils/src/__tests__/redaction.test.ts`.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601).

### AD-test-migration-relative-fixtures: [RESOLVED · Coverage or observability gap · M]

- **Summary:** Upgrade tests built their starting database as "current version minus k" or by dropping a hand-kept list of later tables, so every new migration broke unrelated old tests.
- **Evidence:** `apps/server/src/domains/db/__tests__/pre-migration.fixture.ts` builds a database just before a named migration tag through the runner's own `executableMigrationSql`; the seven upgrade tests (`agent-chat-subagents`, `agent-chat-persistence-migration`, `session-creator`, `chat-permission-migration`, `agent-session-usage`, `terminal-surface-migration`, and `bot/__tests__/inbox`) anchor on tags. `persistence.md` states the rule.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601).

### AD-layout-mobile-colocated-tests: [RESOLVED · Contract drift · S]

- **Summary:** Nine mobile tests sat beside their sources, three of them next to an existing `__tests__/`, because the placement table and the placement contract test did not cover `apps/mobile`.
- **Evidence:** The nine moved into sibling `__tests__/` directories; `scripts/__tests__/test-placement-contract.test.ts` now includes `apps/mobile/src`, and `.agents/skills/source-layout/SKILL.md` has a Mobile row.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601).

### AD-persist-script-atomic-writes: [RESOLVED · Architecture debt · M]

- **Summary:** About 17 repository and skill scripts hand-rolled write-temp-then-rename beside `scripts/atomic-json.ts`, with differing durability and symlink handling, and nothing stopped a new copy.
- **Evidence:** `scripts/atomic-json.ts` gains `writeTextAtomic` (text or bytes) under `writeJsonAtomic`; every inline pair in `scripts/` and `.agents/skills/*/scripts/` now uses them. `scripts/__tests__/atomic-write-contract.test.ts` fails on a new write-then-rename or link pair outside the helper, with a one-entry allowlist for the `link(2)` publisher in `switch-worktree/scripts/repo.ts` that also fails when stale.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601).

### AD-test-precommit-guard-parity: [RESOLVED · Coverage or observability gap · S]

- **Summary:** The required `guards` job ran the React Compiler coverage test and the directory-density ratchet, but the local pre-commit hook ran neither, so a violation surfaced only after a push and a CI round.
- **Evidence:** `.githooks/pre-commit` runs the density ratchet when a commit adds, deletes, or renames files and the React Compiler coverage test when Renderer sources or the compiler ledger change; `.agents/skills/quality-check/SKILL.md` documents it.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601).

### AD-simplify-test-only-surface: [RESOLVED · Architecture debt · M]

- **Summary:** Some exported surface was exercised only by tests while the product used a separate copy, so a green test said nothing about shipped behavior: `config.paths` had no caller, `acceptEventSequence` and `isFileOperationCancelable` duplicated logic owned elsewhere, and `withTerminalRemovedFromLayout` and `sessionsByActivity` were dead.
- **Evidence:** `config.paths` is gone from `packages/protocol/src/registry/method-registry.ts` and the Server handlers; `acceptEventSequence` is deleted so `packages/client/src/state/event-client.ts` is the only gap-handling owner; the resource explorer hook now calls the tested `cancelRevealDelayMs` in `file-operation-state.ts`; the two dead helpers are deleted and the ordering they covered is tested on `compareSessionActivityRecency` in `packages/protocol/src/domain/__tests__/session-order.test.ts`.
- **First seen:** 2026-10-26 @ c23b63b9d · **Last verified:** 2026-10-26 with the fix
- **Resolved:** 2026-10-26 via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601).

### AD-lifecycle-multi-window-watcher-focus: [RESOLVED · Confirmed defect · M]

- **Summary:** With several windows open, focusing a window on a different Session did not rewatch, and the quit prompt could attach to the wrong window; a failed tear-off strip release left a stale strip with no trace.
- **Evidence:** `effects.ts` now also subscribes to `presence.onCurrentChange` and re-runs only the watcher step (`effects.test.ts`); the quit prompt parent is `workbenchWindows.focusedOrPrimary()` (`docs/process-model.md`); `tear-off-windows.ts` retries the strip release once and logs `window.tear_off_release_failed`, with retry and give-up tests.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332). After two failed releases the stale strip remains until next launch (no reconcile-on-restore pass).

### AD-authority-bot-owner-policy: [RESOLVED · Confirmed defect · M]

- **Summary:** Owner-only protection for bot methods lived in a hard-coded set, so a new bot method could be reachable by an Agent principal; Agent identity and cwd validation was duplicated between the known and unknown phase paths.
- **Evidence:** `MethodSpec.principal` with `ownerOnlyCommandPolicy`, read by `assertOwnerOnlyMethod`; a protocol contract test covers every Agent-reachable and control `bot.*` method; `validateAgentIdentity` and `validateAgentCwd` serve both phase paths in `server.ts` with a shared table test.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332). The two reads left owner-only are tracked as `AD-authority-owner-reads-not-project-scoped`.

### AD-persist-atomic-write-duplication: [RESOLVED · Architecture debt · M]

- **Summary:** Several modules hand-rolled temp-file-and-rename writes with different durability, and delegation import and the project search copy each had their own bounded-read or drift risk.
- **Evidence:** `atomicWriteFile` (`durable`, `file`, `none`) in `packages/system/src/filesystem/atomic-write-file.ts` now serves `atomic-file.ts`, private JSON store, process manifest, pricing, argv config, ssh config, and the CLI launcher, with a unit test; delegation import uses `readBoundedTextFile`; a contract test compares the Worker-bound server copy of the project search file with the package copy.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332), except the updater (`AD-persist-atomic-write-updates-streaming`).

### AD-persist-delegation-cap-and-repair-guards: [RESOLVED · Confirmed defect · M]

- **Summary:** Agent delegation records hit the 1024 cap permanently and rejected new tasks; the terminal-tab repair write path and the database drop list had no regression guard.
- **Evidence:** `AgentDelegationsModel.insert` prunes the oldest settled, answer-less, unlinked records before admitting a new one and removes their task directories (`reclaimPrunedDelegationFiles`), keeping the `CAPACITY` error as backstop (`docs/agent-delegation.md`); new tests pin the revision/CONFLICT behavior after a `terminalTabRepair` read and that the drop list matches the current schema tables.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332).

### AD-lifecycle-terminal-exit-finalize: [RESOLVED · Confirmed defect · M]

- **Summary:** If cancelling the Agent or capturing the snapshot failed when a Terminal exited naturally, the Terminal stayed shown as live.
- **Evidence:** `settleTerminalExit` in `apps/server/src/terminal-host/execution-event-projection.ts` isolates the failure and logs `terminalHost.error` phase `exit-finalize`; `projectExecutionExit` always clears state and sends `terminal.exit` without a snapshot (`runtime-generation.test.ts`). Nine unused protocol and mobile-transport exports were also deleted.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332).

### AD-contract-security-docs-and-skill-drift: [RESOLVED · Contract drift · S]

- **Summary:** Security and pairing docs omitted CLI-mediated egress, the Renderer path opener, and the accepted test seams, mis-stated mobile role changes, and the re-render audit skill recommended a Profiler test the repo does not allow.
- **Evidence:** `.agents/skills/project-architecture/references/security.md` sections "CLI-mediated egress", "Renderer-requested path opener", and "Accepted test seams"; the authorization doc now states the fixed `control` role; `react-rerender-audit/SKILL.md` step 6 rewritten; a comment explains the direct delivery of `caxriBot.inboxRequested`.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332). The role-assignment decision stays open as `AD-contract-mobile-view-reply-roles`.

### AD-release-gate-main-ci-and-density: [RESOLVED · Coverage or observability gap · M]

- **Summary:** A red main CI or a directory-density regression could merge or ship because neither the required `guards` job nor release preparation checked them.
- **Evidence:** `guards.yml` runs the density ratchet; `assertMainCiHealthy` in `prepare-release.ts` fails when the newest completed non-release `ci.yml` run on `main` failed (unit tests for failure, pass, and empty cases; rule in the `release` skill).
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332). Remaining gap: `AD-release-gate-ratchet-duplication`.

### AD-lifecycle-chat-states-revision-and-pr-teardown: [RESOLVED · Confirmed defect · M]

- **Summary:** Chat state revisions lacked floors and PR settlement teardown was incomplete; the protocol directory had no density caps or placement rule.
- **Evidence:** Fixed by a concurrent agent in the same batch (F9, F17); not re-verified by this ledger pass beyond the batch report.
- **First seen:** 2026-10-21 @ d0e5f01fc · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332).

### AD-domain-line-budget-splits: [RESOLVED · Architecture debt · M]

- **Summary:** The Server composition root interleaved the Terminal suspension, resource-monitor, and Session-parking lifecycles, so their create, start, and close steps were not discoverable from one owner.
- **Evidence:** `apps/server/src/domains/supervision-services-creation.ts` now owns Terminal suspension and the resource monitor (create, handlers, start, close, in the old order); `apps/server/src/domains/status-service-creation.ts` and `apps/server/src/domains/restore-services-creation.ts` own their slices; the Session parking handlers register together in `apps/server/src/domains/create-domain-services.ts`, which only orders slices and fixes the close order. `apps/server/src/core/__tests__/server-core-shutdown-order.integration.test.ts` covers Server Core's shutdown order around the domain close; `apps/server/src/domains/__tests__/supervision-services-creation.test.ts` pins the slice's own start and close order (suspension fully closes before the resource monitor). The sequence of slices inside the domain `close()` is still fixed by code review only.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via the architecture debt acceptance-gap follow-up to [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264), tracked by [issue caxri#1683](https://github.com/tjx666/caxri/issues/1683).

### AD-sec-project-root-identity: [RESOLVED · Confirmed defect · M]

- **Summary:** Add Project could persist a different folder than the one the user picked when the path was replaced between the pick and the create.
- **Evidence:** `apps/desktop/src/main/root-grants.ts` stores the canonical path, device, and inode captured at pick time; `apps/desktop/src/main/workbench-root-authority.ts` injects that identity as `expectedRootIdentity` and ignores any Renderer-supplied identity. Covered by `apps/desktop/src/main/__tests__/workbench-root-project-identity.test.ts`; Server Core stays the final check in `apps/server/src/domains/__tests__/project-create.integration.test.ts`.
- **First seen:** 2026-10-21 @ 403f8de9a · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264).
- **Remediation target / Acceptance:** A replaced folder returns `PATH_DENIED`, inserts no Project, and cannot be retried with the same grant.

### AD-lifecycle-outer-provider-recovery: [RESOLVED · Confirmed defect · S]

- **Summary:** A render failure in the I18n or Query provider bypassed the crash recovery screen, leaving the Workbench on its launch layer and auxiliary windows blank.
- **Evidence:** `apps/desktop/src/renderer/src/renderer-root.tsx` puts the `ErrorBoundary` outside every provider for all four Renderer entries. Covered by `e2e/root-error-boundary.e2e.ts`.
- **First seen:** 2026-10-21 @ 403f8de9a · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264).
- **Remediation target / Acceptance:** A provider-level failure shows the recovery screen with a working Reload in every window.

### AD-toolchain-node-types-major: [RESOLVED · Contract drift · S]

- **Summary:** `@types/node` 26 declared APIs that the shipped Node 24 runtime lacks, so code could typecheck and then fail at runtime.
- **Evidence:** Every workspace pins `@types/node` `^24`; `scripts/__tests__/toolchain-contract.test.ts` asserts the major matches `mise.toml` and that a Node 26-only builtin fails typecheck.
- **First seen:** 2026-10-21 @ 403f8de9a · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264).
- **Remediation target / Acceptance:** Runtime and declaration majors cannot drift apart silently.

### AD-tooling-watch-ci-operands: [RESOLVED · Confirmed defect · S]

- **Summary:** `watch-ci` value flags accepted a missing, empty, or flag-like operand and fell through to Git and GitHub calls, sometimes silently watching the current branch.
- **Evidence:** `scripts/watch-ci.ts` validates every value flag in one operand reader; `scripts/__tests__/watch-ci-arguments.test.ts` asserts zero external calls for twelve invalid forms.
- **First seen:** 2026-10-21 @ 403f8de9a · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264).
- **Remediation target / Acceptance:** Invalid operands fail before any process call.

### AD-ui-interaction-state-tokens: [RESOLVED · Architecture debt · M]

- **Summary:** Hover, selected, and focus washes were hand-mixed with `color-mix` in about 25 Renderer files with no semantic owner.
- **Evidence:** `apps/desktop/src/renderer/src/styles/theme.css` owns the `--state-*` tokens derived from theme roles, so imported themes inherit them; `DESIGN.md` documents the classes. `apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts` fails on a new hand-mixed recipe.
- **First seen:** 2026-10-21 @ 403f8de9a · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264).
- **Remediation target / Acceptance:** One named token per interaction-state class; surfaces may still differ in intensity.

### AD-docs-process-explorer-stop-terminal: [RESOLVED · Contract drift · S]

- **Summary:** Architecture references described the Process Explorer preload as snapshot-only although it ships a narrow `stopTerminal` action.
- **Evidence:** `.agents/skills/project-architecture/references/ipc.md`, `.agents/skills/project-architecture/references/process-model.md`, and `docs/process-explorer.md` now describe `stopTerminal` as a sender- and identifier-validated `terminal.suspend`, not a request bridge or process kill.
- **First seen:** 2026-10-21 @ 403f8de9a · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264).
- **Remediation target / Acceptance:** References match the shipped preload without widening it.

### AD-sec-delegation-hidden-project: [RESOLVED · Contract drift · S]

- **Summary:** Delegation bootstrap reuses a hidden Project for its root and creates a Session there that Desktop never shows.
- **Evidence:** `apps/server/src/domains/db/delegation-context.ts` restores a hidden Project through `ProjectsModel.create` before creating the delegated Session; covered by `apps/server/src/domains/db/__tests__/delegation-context.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-20 @ 7850276e5 via [issue caxri#1677](https://github.com/tjx666/caxri/issues/1677)
- **Remediation target / Acceptance:** [issue caxri#1677](https://github.com/tjx666/caxri/issues/1677): unhide or refuse, with an integration test.

### AD-test-knip-before-merge: [RESOLVED · Coverage or observability gap · S]

- **Summary:** An ordinary PR that leaves an unused export can merge green and fail only on the
  post-merge `main` push.
- **Evidence:** `scripts/run-ci-focused-checks.ts` runs `--knip` in the `affected` scope, so an unused export fails before merge.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-20 @ 7850276e5 via [issue caxri#1679](https://github.com/tjx666/caxri/issues/1679)
- **Remediation target / Acceptance:** [issue caxri#1679](https://github.com/tjx666/caxri/issues/1679): knip in the `affected` scope or `guards`.

### AD-ui-native-title-tooltips: [RESOLVED · Contract drift · M]

- **Summary:** Native `title` attributes carried unique or truncated text (command IDs, paths, exit status) that keyboard users could not reach.
- **Evidence:** The shared Tooltip on focusable triggers now carries that text; the Terminal announces command exit status through its live region. `scripts/eslint-rules/native-title.ts` rejects a new native title outside the reasoned inventory in `scripts/eslint-rules/native-title-inventory.ts`; covered by `scripts/__tests__/native-title.test.ts`. The separate file-reference component consolidation was not revalidated here and stays with the issue.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264)
- **Remediation target / Acceptance:** [issue caxri#1678](https://github.com/tjx666/caxri/issues/1678): lint rule plus one file-reference component.

### AD-domain-implementation-barrels: [RESOLVED · Architecture debt · M]

- **Summary:** Seven `index.ts` files hold 400 to 760 lines of implementation, contradicting the thin-barrel rule and seeding the pattern.
- **Evidence:** The seven `index.ts` files are re-export-only barrels over named modules such as `apps/server/src/domains/git/service.ts`; `scripts/__tests__/thin-barrels.test.ts` enforces it.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-21 with the fix
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264)
- **Remediation target / Acceptance:** [issue caxri#1680](https://github.com/tjx666/caxri/issues/1680): barrels export only, enforced by a structure test.

### AD-dup-chat-revision-sync: [RESOLVED · Architecture debt · M]

- **Summary:** Desktop and Mobile each implement the Agent Chat revision-chain hold, replay, and re-read logic, so a sync fix lands twice and the two clients can drift.
- **Evidence:** `packages/protocol/src/agent/agent-chat-revision-convergence.ts` owns hold, replay, gap, overflow, re-read, and dispose decisions for both clients; vectors in `packages/protocol/src/agent/__tests__/agent-chat-revision-convergence.test.ts`.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-21 @ d0e5f01fc (still present)
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264)
- **Remediation target / Acceptance:** [issue caxri#1801](https://github.com/tjx666/caxri/issues/1801): one pure revision-chain core in `packages/protocol/src/agent/` used by both clients.

### AD-layout-agent-chat-flat-feature: [RESOLVED · Architecture debt · M]

- **Summary:** `features/agent-chat` keeps 80+ files flat although `turn-*`, `task*`, and `find*` families form cohesive sub-domains, so placing and finding Chat code costs every change a directory scan.
- **Evidence:** `apps/desktop/src/renderer/src/features/agent-chat/` keeps 12 direct production modules; families live in sub-domain directories such as `turns/`, `tasks/`, `composer/`, and `find/`.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-21 @ d0e5f01fc (still present)
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264)
- **Remediation target / Acceptance:** [issue caxri#1802](https://github.com/tjx666/caxri/issues/1802): pure moves into sub-domain directories with before/after visual parity.

### AD-naming-ssh-host-identifiers: [RESOLVED · Contract drift · M]

- **Summary:** The glossary names the feature SSH Host and lists Remote as an alias to avoid in new code, yet the protocol methods are `remote.*`, Main splits the feature between `ssh/remote-*.ts` and flat `remote-*` siblings, and the doc is titled Remote SSH; Environment is used as a concept without a glossary entry.
- **Evidence:** `packages/protocol/src/desktop/ssh-host-contract.ts` exposes `sshHost.*` methods; Main owners live in `apps/desktop/src/main/ssh/`; `docs/ssh-host.md` is the living doc and `GLOSSARY.md` defines Environment. `scripts/__tests__/ssh-host-vocabulary.test.ts` rejects the retired spellings.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-21 @ d0e5f01fc (ratchet went red at that commit; restored by the [issue caxri#2332](https://github.com/tjx666/caxri/issues/2332) batch, which also moved agent-chat entries and added protocol density caps)
- **Resolved:** 2026-10-21 via [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264)
- **Remediation target / Acceptance:** [issue caxri#1994](https://github.com/tjx666/caxri/issues/1994): one SSH Host vocabulary across protocol, Main modules, and docs, with Environment defined in the glossary.

### AD-simplify-shared-single-flight: [RESOLVED · Modernization opportunity · M]

- **Summary:** `SingleFlight` lived under Server domains, so Desktop Main and other owners hand-rolled dedupe and per-key serialization with diverging eviction semantics.
- **Evidence:** `packages/system/src/process/single-flight.ts` (join in-flight work) and `keyed-serial-queue.ts` (strict per-key FIFO) are now the shared primitives; Provider status, executable discovery, messaging capability probes, the external-link target probe, Session rename, mobile Terminal mutations, Chat permission switches, and `argv.jsonc` writes use them. Retained-result caches (link favicons and previews, parsed transcripts) stay specialized and say why.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-20 with the fix
- **Resolved:** 2026-10-20 via [issue caxri#1681](https://github.com/tjx666/caxri/issues/1681).
- **Remediation target / Acceptance:** One primitive in `packages/system`.

### AD-ext-virtual-tab-descriptors: [RESOLVED · Architecture debt · M]

- **Summary:** Adding a virtual editor tab scheme needed coordinated edits in eight or nine files without an exhaustive check.
- **Evidence:** `packages/protocol/src/domain/virtual-tabs.ts` registers each scheme once; the Renderer's `virtualTabDescriptors` (`features/editor/virtual-tab-descriptors.ts`) and `VIRTUAL_TAB_SURFACES` (`editor-surface.tsx`) are `Record`s keyed by that union, so tab display, icon, surface, and status bar eligibility are looked up and a missing scheme fails typecheck. Covered by `features/editor/__tests__/virtual-tab-descriptors.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-20 with the fix
- **Resolved:** 2026-10-20 via [issue caxri#1682](https://github.com/tjx666/caxri/issues/1682).
- **Remediation target / Acceptance:** One exhaustive descriptor table.

### AD-proc-chat-endpoint-identity: [RESOLVED · Contract drift · M]

- **Summary:** An Agent running on the Chat surface had no Agent Endpoint identity, so `caxri agent message send` was refused and `caxri agent delegate create` ran as the operator instead of as that Agent.
- **Evidence:** `apps/server/src/domains/agent-chat/chat-endpoint.ts` now issues every Chat start its own Endpoint generation, with Caxri Bot role only for Caxri Bot Terminal. Covered by `apps/server/src/domains/agent-chat/__tests__/chat-endpoint.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-13 with the fix
- **Resolved:** 2026-10-13 via [issue caxri#1675](https://github.com/tjx666/caxri/issues/1675).
- **Remediation target / Acceptance:** A Chat Agent's `caxri` commands authenticate as its own Endpoint, never as the operator.

### AD-sec-main-link-fetch-trust: [RESOLVED · Contract drift · S]

- **Summary:** Rendering or hovering a transcript link made Main request the origin's favicon or the full URL without excluding loopback or private hosts, and redirects were followed; the provider status read had no body cap.
- **Evidence:** `apps/desktop/src/main/public-https-fetch.ts` vets every hop of `link-favicons.ts` and `link-previews.ts`; `packages/system/src/network/agent-provider-status.ts` reads through `packages/system/src/network/read-capped-body.ts`. Covered by `public-https-fetch.test.ts`, `link-favicons.test.ts`, `link-previews.test.ts`, and `agent-provider-status.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-13 with the fix
- **Resolved:** 2026-10-13 via [issue caxri#1676](https://github.com/tjx666/caxri/issues/1676).
- **Remediation target / Acceptance:** Internal, loopback, and redirect-to-internal URLs are never requested; an oversize status page is cancelled and reported as `invalidResponse`.

### AD-proc-ssh-server-node-env: [RESOLVED · Contract drift · S]

- **Summary:** The SSH Host launch script removed only `SSH_*` variables, so a `NODE_OPTIONS` or `NODE_PATH` from the host's login shell reached the remote Server Core process, unlike the local launch path's environment allowlist.
- **Evidence:** `apps/desktop/src/main/ssh/remote-scripts.ts` launch script unsets them; `remote-scripts.test.ts` launches with both set. Terminal Host and Extension Host already used the sanitized environment.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** The remote Server Core starts without the host's Node runtime flags.

### AD-sec-server-price-list-fetch: [RESOLVED · Coverage or observability gap · S]

- **Summary:** The Server's price-list download buffered the whole body before its 16 MiB check, was missing from the outbound-request inventory, and ran for real in E2E and Acceptance.
- **Evidence:** `apps/server/src/domains/usage/pricing.ts` `readBoundedText` and `offlinePriceListFetch`; `apps/server/src/domains/service-handlers.ts` injects it under `CAXRI_E2E=1`; `security.md` Server outbound requests.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** An oversized body is dropped while streaming, E2E stays offline, and the inventory lists the request.

### AD-ui-local-only-predicate: [RESOLVED · Contract drift · S]

- **Summary:** The Chat composer's Files and folders picker and New Project gated local-only native pickers with `isRemote`, which treats an unknown environment as local, instead of `isLocalOnlyAvailable`.
- **Evidence:** `features/agent-chat/hooks/use-agent-chat-file-input.ts`; `features/session/session-creation-commands.ts` and its test.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** Every local-only entry point uses `isLocalOnlyAvailable`.

### AD-sec-bot-handover-owner: [RESOLVED · Architecture debt · S]

- **Summary:** An Agent holding an `agent:control` grant could hand any Session to Caxri Bot, take one back, or list external conversations, because those methods only required the `agents.control` capability.
- **Evidence:** `apps/server/src/core/principal-project-scope.ts` `assertOwnerHandover` runs before dispatch in `apps/server/src/core/server-core.ts`; `server-core-agent-endpoint.integration.test.ts` covers the granted Agent.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** Only Desktop and the human CLI can hand over, take back, or list conversations; a granted Agent gets `FORBIDDEN`.

### AD-ui-ssh-local-file-drop: [RESOLVED · Confirmed defect · S]

- **Summary:** Dropping a file from this Mac into a Terminal or the Chat composer of an SSH Host window inserted a local path that does not exist on the host.
- **Evidence:** `apps/desktop/src/renderer/src/lib/file-drag.ts` `isOsFileReferenceRefused`; `features/terminal/terminal-drop.ts` and `hooks/use-agent-chat-composer-input.ts` show a toast; `docs/ssh-host.md` lists the limit.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** OS file drops are refused in SSH Host windows with an explanation; local windows are unchanged.

### AD-state-composer-window-scope: [RESOLVED · Confirmed defect · S]

- **Summary:** Composer drafts, edits, and attachments were stored under one key and one IndexedDB database shared by every window on the `file://` origin, so retention in one window pruned another window's drafts and SSH Host Terminals could collide with local ones.
- **Evidence:** `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-attachment-persistence.ts` scopes storage to `local`, `bot`, or `ssh:<hostIdentity>`; `SshEnvironmentState.hostIdentity` carries Main's host key.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** Each window scope keeps its own drafts and attachments; retention never crosses scopes.

### AD-state-mobile-chat-root-follow: [RESOLVED · Confirmed defect · S]

- **Summary:** After a Session followed a new worktree, the phone's Agent Chat kept naming changed files relative to the old root.
- **Evidence:** `apps/server/src/core/mobile/gateway/subscriptions.ts` refreshes the Chat root on `workbench.changed` and sends a full `agentChat.changed` while the refresh is pending.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** Changed-file paths follow the Session's current root.

### AD-perf-chat-history-retention: [RESOLVED · Architecture debt · S]

- **Summary:** Loading older Agent Chat history on Desktop retained every evicted item without a bound.
- **Evidence:** `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-history.ts` `MAX_AGENT_CHAT_RETAINED_HISTORY_ITEMS`; `docs/agent-chat.md`.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** Retained history stops at 5,000 items and can be loaded again on demand.

### AD-state-bot-handover-races: [RESOLVED · Confirmed defect · S]

- **Summary:** Handing the same Session to Caxri Bot twice while conversation discovery was pending recorded two hand-overs and two tasks, a hand-over accepted during the first Caxri Bot launch was overwritten, and a conversation reached through a symlinked folder created a nested Project.
- **Evidence:** `apps/server/src/domains/bot/handover.ts` decides existing Sessions after the last await; `service.ts` re-reads rows in `beforeStart`; `session/import-conversation.ts` matches the canonical folder.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** One hand-over per Session, launches keep concurrent hand-overs, and symlinked conversations land in their existing Project.

### AD-dup-settings-copy-drift: [RESOLVED · Contract drift · S]

- **Summary:** Settings search indexed protocol English titles that said Pause while the English UI said Suspend, and eleven protocol presentation helpers had no consumer.
- **Evidence:** `packages/protocol/src/configuration/settings-spec.ts`; `features/settings/__tests__/settings-catalog-parity.test.ts`; orphan helpers removed from `packages/protocol/src/domain/` and `agent/`.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** The settings parity test fails on any title or description drift; no orphan copy helper remains.

### AD-test-desktop-copy-parity: [RESOLVED · Coverage or observability gap · S]

- **Summary:** Main-only `desktop` strings and Desktop English counterparts of protocol helpers had no parity test, so wording or rule changes could drift silently.
- **Evidence:** `apps/desktop/src/renderer/src/i18n/__tests__/i18n.test.ts` covers the `desktop` namespace; `apps/desktop/src/renderer/src/i18n/__tests__/english-counterpart-parity.test.ts` registers 17 pairs and found two drifts, now aligned: an interrupted stop tool read `Stopped stopping` on the phone, and the `hands` Inbox kind read `Needs your hands` there but `Needs you` on Desktop; `docs/i18n.md`. Acceptance labels in `extensions/status` stay unguarded because application code cannot import an extension.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** Every Desktop English counterpart is registered in the parity test.

### AD-deps-lobehub-ui-boundary: [RESOLVED · Contract drift · S]

- **Summary:** `@lobehub/ui` had no stack-baseline record and no import boundary, so its antd/Emotion component kit could spread through the Renderer.
- **Evidence:** `.agents/skills/project-architecture/references/stack-baseline.md` accepted runtime exception; `eslint.config.ts` Renderer `no-restricted-imports` with an i18n-only override.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** Only `apps/desktop/src/renderer/src/i18n/` imports the library.

### AD-toolchain-release-age-exclusions: [RESOLVED · Contract drift · S]

- **Summary:** `minimumReleaseAgeExclude` kept six entries for versions no longer in the lockfile, and one entry was unpinned.
- **Evidence:** `pnpm-workspace.yaml`; `scripts/__tests__/toolchain-contract.test.ts` checks that every exclusion is exact and still resolved.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** Stale or unpinned exclusions fail the toolchain contract.

### AD-docs-authority-and-baseline-drift: [RESOLVED · Contract drift · S]

- **Summary:** Docs omitted the SSH Host folder browser and Caxri Bot import as Project-registration authorities, claimed a granted Agent could hand over Sessions, and described the bundle baseline as current Electron 44.
- **Evidence:** `.agents/skills/project-architecture/references/security.md`; `apps/desktop/src/main/workbench-root-authority.ts` JSDoc; `docs/caxri-bot.md`; `docs/bundle-size.md`.
- **First seen:** 2026-10-13 @ 319eab82e · **Last verified:** 2026-10-13 with the fix batch
- **Resolved:** 2026-10-13 via [issue caxri#1992](https://github.com/tjx666/caxri/issues/1992).
- **Remediation target / Acceptance:** Docs match runtime authority and date the measured Electron version.

### AD-sec-bot-chat-edit-refused: [RESOLVED · Confirmed defect · S]

- **Summary:** Editing or restoring a message in Caxri Bot Chat failed because Main's Caxri Bot policy refused `agentChat.rewind`, `agentChat.restoreFiles`, and the revert confirmation, and the confirmation attached to the Workbench window.
- **Evidence:** `apps/desktop/src/main/caxri-bot-policy.ts` admits them, refuses `agentChat.fork` explicitly, and an exhaustiveness test classifies every `agentChat.*` method; `apps/desktop/src/main/request-window.ts` `requestWindowOr` parents the prompt to the requesting window.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Edit and Restore work in Caxri Bot Chat; Fork is hidden there; the confirmation sheet opens on the window that asked.

### AD-state-fork-permission-inherit: [RESOLVED · Confirmed defect · S]

- **Summary:** A "Fork from here" Chat reset to the Project default permission and plan mode instead of keeping its source Chat's choice.
- **Evidence:** `apps/server/src/domains/session/creation.ts` `inheritChatPermission`, fed by `sourceTerminalId` from `chat-fork.ts`; covered by `service-fork.integration.test.ts`.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** A fork keeps the source Chat's stored level and plan mode and falls back to the default only when the source stored none.

### AD-diag-chat-rewind-outcome: [RESOLVED · Coverage or observability gap · S]

- **Summary:** Rewind and file-restore logs recorded success before the restart and resend finished and gave refusals no cause.
- **Evidence:** `agent_chat.rewound` is written after restart and send, refusals carry a closed `reason` and `code`, and `resendFailed` records a failed resend; `packages/protocol/src/domain/logging.ts` documents the fields.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** A failed or refused rewind is distinguishable in logs by reason.

### AD-test-chat-capability-parity: [RESOLVED · Coverage or observability gap · S]

- **Summary:** No test tied each Chat driver's declared capabilities to the methods it implements.
- **Evidence:** `apps/server/src/domains/agent-chat/__tests__/chat-drivers.test.ts` asserts parity per driver.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** A driver that declares a capability without implementing it fails the test.

### AD-owner-chat-permission-mapping: [RESOLVED · Architecture debt · S]

- **Summary:** One shared module mapped every provider's permission levels, so a provider change edited a file owned by all three.
- **Evidence:** `chat-permissions.ts` is provider-neutral; `codex-`, `claude-`, and `grok-permissions.ts` own each mapping with their own tests.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Adding or changing a provider's levels touches only that provider's file.

### AD-perf-bot-keystroke-queries: [RESOLVED · Architecture debt · S]

- **Summary:** Caxri Bot completion notices, suspension, and launch environment re-queried Caxri Bot Session and Terminal rows on hot paths.
- **Evidence:** `apps/server/src/domains/db/bot-rows.ts` `caxriBotIdentity` and `caxriBotTerminal`; query-count tests in `bot/__tests__/completion-notice-cost.integration.test.ts` and `terminal/__tests__/bot-lookup-cost.integration.test.ts`.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** The hot paths read Caxri Bot rows at most once per call.

### AD-lifecycle-chat-composer-state-retire: [RESOLVED · Confirmed defect · S]

- **Summary:** Composer attachments, pending edits, and menu state of a closed Chat stayed in Renderer memory for the app's lifetime.
- **Evidence:** `retainAgentChatComposerState` and `retainAgentChatEdits` run beside `retainTerminalProgress` in `features/workbench/workbench.tsx`; text drafts are kept on purpose.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Closing a Chat drops its non-draft composer state.

### AD-dup-find-bar: [RESOLVED · Architecture debt · S]

- **Summary:** Terminal search and Chat find each built their own find bar with different labels and no-match feedback.
- **Evidence:** `apps/desktop/src/renderer/src/components/find-bar.tsx` serves both; `e2e/agent-chat-find.e2e.ts` covers it.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Both surfaces show the same labels, the same `No results` state, and disable navigation without matches.

### AD-dup-inbox-mention-picker: [RESOLVED · Architecture debt · S]

- **Summary:** The Bot Inbox `@` picker was a separate implementation with weaker keyboard and screen-reader behavior than Chat's suggestion menu.
- **Evidence:** `apps/desktop/src/renderer/src/lib/suggestion-options.ts` and `components/suggestion-list.tsx` back both menus, including `suggestionMenuKeyAction` and `aria-activedescendant`.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Both pickers share keys, rendering, and accessibility wiring.

### AD-ui-bot-terms-icons: [RESOLVED · Contract drift · S]

- **Summary:** Caxri Bot startup badge reused "Needs you", the Inbox toggle used a generic icon, and Settings named the Peer Inbox inconsistently.
- **Evidence:** The badge reads "Waiting at startup", the toggle uses `MessageSquareWarning`, and GLOSSARY defines Peer Inbox.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** One term per concept across Caxri Bot window, Settings, and docs.

### AD-ui-bot-project-default: [RESOLVED · Confirmed defect · S]

- **Summary:** Caxri Bot Chat permission menu offered "Use as Project default", which always failed because Caxri Bot policy refuses Project writes.
- **Evidence:** `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-host.ts` derives `canFork` and `canSaveProjectDefault` from the host window.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** The row is absent in Caxri Bot window and unchanged in the Workbench.

### AD-lifecycle-claude-fork-malformed: [RESOLVED · Confirmed defect · S]

- **Summary:** One malformed line in a Claude transcript made "Fork from here" fail with `Unexpected end of JSON input`, and the store read transcripts of any size.
- **Evidence:** `claude-rewind.ts` parses line by line, skips and counts malformed records (`agent_chat.forked.skippedRecords`), and refuses with `CAPACITY` above 256 MiB.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Fork succeeds over malformed lines and refuses oversized transcripts clearly.

### AD-diag-bot-terminal-diagnostics: [RESOLVED · Coverage or observability gap · S]

- **Summary:** Terminal renderer, GPU budget, OSC 52, and resize-burst diagnostics from Caxri Bot window were dropped because Main accepted them only from the Workbench.
- **Evidence:** `apps/desktop/src/main/workbench-ipc.ts` accepts the Terminal diagnostics from both windows and tags them with a closed `window` field.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Caxri Bot Terminal incidents appear in logs with `window: 'bot'`.

### AD-lifecycle-external-watcher-retry: [RESOLVED · Confirmed defect · S]

- **Summary:** After an external document's folder was removed and recreated, outside edits to the open file were never reported again.
- **Evidence:** `apps/desktop/src/main/external-document-watcher.ts` keeps the watched set in Main and retries a failed watch at 1s, 5s, and 30s, then rechecks the folder's documents.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Outside edits are reported again after the folder returns.

### AD-dup-chat-presentation-copy: [RESOLVED · Architecture debt · S]

- **Summary:** Desktop and Mobile each spelled out Chat failure and empty-state copy and built question answers separately.
- **Evidence:** Shared helpers in `packages/protocol/src/agent/` with each surface's exact strings preserved; the revision sync core remains open as AD-dup-chat-revision-sync.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Copy and answer building have one owner.

### AD-test-protocol-test-placement: [RESOLVED · Architecture debt · S]

- **Summary:** Protocol tests sat outside the package's test layout.
- **Evidence:** Relocated beside their sources under `packages/protocol`.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Protocol tests follow source-layout.

### AD-toolchain-pdfjs-notices: [RESOLVED · Contract drift · S]

- **Summary:** The pdf.js preview shipped without its license in the third-party notices.
- **Evidence:** `THIRD_PARTY_NOTICES` and `licenses/` include pdf.js.
- **First seen:** 2026-10-12 @ d5dbb34f6 · **Last verified:** 2026-10-12 with the fix batch
- **Resolved:** 2026-10-12 via [issue caxri#1795](https://github.com/tjx666/caxri/issues/1795).
- **Remediation target / Acceptance:** Every bundled dependency has its notice.

### AD-perf-usage-locate-every-poll: [RESOLVED · Architecture debt · M]

- **Summary:** Every Usage poll re-located every outside-Caxri transcript; [PR caxri#1658](https://github.com/tjx666/caxri/pull/1658) widened the set to every conversation on the machine.
- **Evidence:** `apps/server/src/domains/usage/service.ts` fingerprints outside scans and persists `claudeMisses`, so unchanged transcripts are not re-located.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-12 @ d5dbb34f6
- **Resolved:** [PR caxri#1733](https://github.com/tjx666/caxri/pull/1733) (`4beabffa7`), closing [issue caxri#1585](https://github.com/tjx666/caxri/issues/1585).
- **Remediation target / Acceptance:** cache locations across polls.

### AD-lifecycle-chat-start-after-park: [RESOLVED · Confirmed defect · S]

- **Summary:** Archiving a Session or hiding its Project while its Chat was restarting or switching surface still spawned the provider in the parked Session.
- **Evidence:** `apps/server/src/domains/agent-chat/chat-states.ts` `admit` refuses a Chat whose Session is archived or whose Project is hidden, the same predicate that parks a landing PTY launch; `service-admission.integration.test.ts` covers archive and hide landing mid-restart.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** A restart racing archive or hide spawns the provider at most once (the original) and never in the parked Session.

### AD-sec-chat-cwd-revalidation: [RESOLVED · Confirmed defect · S]

- **Summary:** A Chat provider started in whatever the Project folder had become (a symlink to elsewhere, or a removed folder reported as `executable_not_found`), while PTY launches revalidated it.
- **Evidence:** `apps/server/src/domains/agent-chat/chat-launch.ts` `prepareChatLaunch` captures the cwd identity and revalidates it with `assertTerminalWorkingDirectory` as the last await before spawn; covered by `service-admission.integration.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** A swapped or removed folder fails the Chat start with `spawn_failed` and no spawn.

### AD-state-tree-children-view-context: [RESOLVED · Confirmed defect · S]

- **Summary:** Extension tree children requested before a Session switch could be computed for, and delivered into, the other Session's tree.
- **Evidence:** `viewContainers.treeChildren` carries `context` and `apps/server/src/core/extensions/service.ts` asserts it before and after activation and after the provider answers; mobile passes the checked context through `apps/server/src/core/mobile/panel-requests.ts`. Covered by `service-tree-children.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** A stale-context tree read rejects with `CANCELLED` and never reaches the Extension Host.

### AD-lifecycle-extension-host-restart-waiters: [RESOLVED · Confirmed defect · S]

- **Summary:** Restarting the Extension Host left callers waiting on the old startup for the 15s ready timeout and never aborted the old child's in-flight Extension API requests.
- **Evidence:** `apps/server/src/core/extensions/supervisor.ts` `retireChild` is shared by `handleExit` and `restart`; `supervisor-restart.test.ts` covers both gaps.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** Restart settles readiness waiters with `EXTENSION_HOST_UNAVAILABLE` and aborts old API requests immediately.

### AD-perf-favicon-unbounded-read: [RESOLVED · Confirmed defect · S]

- **Summary:** A favicon without `content-length` was buffered whole before the 32 KiB cap applied, and a failed request was cached for the life of the app.
- **Evidence:** `packages/system/src/network/read-capped-body.ts` is the one capped stream reader for favicons and link previews; `link-favicons.ts` forgets outright failures. Covered by `link-favicons.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** An oversize chunked body is cancelled early; a failed origin is retried on the next render.

### AD-perf-usage-describe-fanout: [RESOLVED · Architecture debt · S]

- **Summary:** The outside-transcript sync started one filesystem walk per transcript at once, thousands on a long history.
- **Evidence:** `apps/server/src/domains/usage/service.ts` `describeOutsideTranscripts` uses `mapWithConcurrency` with `SCAN_CONCURRENCY`; covered by the usage service test.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667); cross-poll caching remains `AD-perf-usage-locate-every-poll`.
- **Remediation target / Acceptance:** Peak concurrent describes never exceed the cap.

### AD-ui-status-bar-virtual-tabs: [RESOLVED · Confirmed defect · S]

- **Summary:** The status bar showed file position and type for Markdown preview and Agent transcript tabs.
- **Evidence:** `apps/desktop/src/renderer/src/features/status-bar/active-file-status-target.ts` defers to `isVirtualEditorTabPath`; unit test enumerates every virtual scheme; verified over CDP on a preview tab.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** No virtual tab shows file status.

### AD-ui-mermaid-custom-theme-cache: [RESOLVED · Confirmed defect · S]

- **Summary:** After editing a custom theme's colors, Mermaid diagrams kept the old colors until reload.
- **Evidence:** `apps/desktop/src/renderer/src/features/preview/markdown-diagrams.ts` keys initialization and the render cache on `mermaidThemeKey(theme)`; covered by `markdown-diagrams.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** Same theme id with new colors re-initializes and misses the cache.

### AD-ui-snapshot-failure-copy: [RESOLVED · Contract drift · S]

- **Summary:** Any failed Projects-and-Sessions read, including a background refresh, said "Unable to attach to the Runtime", an internal term.
- **Evidence:** `apps/desktop/src/renderer/src/stores/workbench-snapshot-failure.ts` distinguishes load from refresh in glossary terms; `e2e/support/error-gate.ts` classifies the new copy.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** Load and refresh failures use distinct copy; cancellations stay silent.

### AD-test-preload-event-errors: [RESOLVED · Coverage or observability gap · S]

- **Summary:** Preload swallowed Server event-stream failures, and its IPC channel literals were not bound to the protocol constants.
- **Evidence:** `apps/desktop/src/preload/index.ts` logs event-stream failures without payloads; the literals stay (a sandboxed preload cannot load a shared chunk) but are typed against `RENDERER_ERROR_CHANNELS` and `RENDERER_DIAGNOSTIC_CHANNEL`. Covered by `preload/__tests__/index.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** A failed event stream is logged; renaming a protocol channel fails typecheck.

### AD-ext-main-owned-domain-stubs: [RESOLVED · Architecture debt · S]

- **Summary:** Every new Desktop-owned method forced a stub in `apps/server/src/domains`, and most stubs claimed Electron Main owned methods that Server Core handles itself.
- **Evidence:** `apps/server/src/domains/domain-services.ts` types `DomainHandlers` over `DomainOperation`, derived from protocol owner metadata and `desktopServerOperationIds`; `resolveDomainHandler` in `apps/server/src/core/operation-dispatcher.ts` rejects an unowned method with `CONFLICT`; `core-routed.ts` keeps only the Core-handled entries. Covered by `operation-dispatcher.test.ts`.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** Adding a Desktop-owned method typechecks with no edit under `apps/server/src/domains`.

### AD-toolchain-agent-doc-drift: [RESOLVED · Contract drift · S]

- **Summary:** Skills and docs disagreed with the toolchain: an 800-line split threshold against the 600-line ratchet, knip claimed on every PR, a fully self-hosted CI, an "LRU" link cache, and Chat claimed to share the PTY Agent environment.
- **Evidence:** `source-layout`, `quality-check`, and `pull-request` skills; `docs/quality-toolchain.md`, `docs/ci-performance.md`, and `docs/agent-chat.md`; `security.md` lists Main's outbound requests and the delegation bootstrap.
- **First seen:** 2026-10-11 @ 0497d1310 · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1667](https://github.com/tjx666/caxri/issues/1667).
- **Remediation target / Acceptance:** Each statement matches the cited script or workflow.

### AD-lifecycle-chat-closed-queue-respawn: [RESOLVED · Confirmed defect · S]

- **Summary:** Closing a Chat while messages were still queued behind its startup could launch a new, invisible provider for the deleted Terminal, inflating the live count and keeping Server Core from its idle exit.
- **Evidence:** `apps/server/src/domains/agent-chat/chat-states.ts:172` admits a send against the current state and Terminal row at entry and again at the queue head (`apps/server/src/domains/agent-chat/service.ts` `enqueueOn()`), so a retired state or a deleted row rejects instead of starting; `apps/server/src/domains/agent-chat/__tests__/service-admission.integration.test.ts` covers queued sends across close and row deletion.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** Three or more queued sends followed by close and row deletion spawn the provider at most once and leave `liveCount()` at zero.

### AD-lifecycle-chat-detach-relaunch: [RESOLVED · Contract drift · M]

- **Summary:** After a Session was detached for another client, merely reading its Chat relaunched the provider and resumed the same Agent Session the external client was using.
- **Evidence:** `apps/server/src/domains/agent-chat/chat-states.ts:207-219` records a requested stop during detach as `detached`; `read()` no longer starts a detached Chat, sends reject with UNAVAILABLE, and `session.resume` clears the marker (`apps/server/src/domains/create-domain-services.ts:536`). `apps/server/src/domains/__tests__/session-detach-chat.integration.test.ts` covers detach, read, send, and resume.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** Detach persists a durable marker; read and send never relaunch it; only `session.resume` or an explicit restart clears it.

### AD-env-inherited-allowlist-split: [RESOLVED · Confirmed defect · S]

- **Summary:** Launching Caxri from a shell with proxy or custom CA variables stripped them at the Server Core hop, so Agent Chats, Git, and naming processes lost network access; per-provider state keys also had four drifting copies.
- **Evidence:** `packages/protocol/src/agent/agent-process-environment.ts` owns `AGENT_STATE_ENVIRONMENT_KEYS` and `INHERITED_PROCESS_ENVIRONMENT_KEYS`; `packages/client/src/supervise/launch.ts` and `packages/system/src/process/environment.ts` both read the shared list, with the latter covered by `packages/system/src/process/__tests__/environment.test.ts`.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** Both hops import one inherited allowlist; the provider-state table remains exhaustive by type.

### AD-lifecycle-dispatch-archive-race: [RESOLVED · Confirmed defect · S]

- **Summary:** Archiving a Session while an Agent was being dispatched into it could insert and start the Agent in the archived Session, where it kept running out of sight.
- **Evidence:** `apps/server/src/domains/db/agent-dispatch-terminal.ts:24` rechecks the archive inside the insert transaction, and `apps/server/src/domains/agent-dispatch/service.ts:380-389` rechecks after the resume wait; `apps/server/src/domains/agent-dispatch/__tests__/service.test.ts` covers both windows.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** A dispatch racing an archive fails with CONFLICT and never inserts a Terminal into the archived Session.

### AD-persist-hook-config-symlink-replace: [RESOLVED · Confirmed defect · S]

- **Summary:** Installing or repairing Agent hooks replaced a symlinked provider settings file (for example one managed by a dotfiles repository) with a standalone copy, silently detaching it from its source.
- **Evidence:** `apps/server/src/domains/atomic-file.ts:49` `atomicWriteUserConfig` writes through a final symlink and keeps the target's mode; `apps/server/src/domains/agents/hooks/manager.ts:467` uses it. `apps/server/src/domains/agents/hooks/__tests__/manager-symlink.integration.test.ts` and `apps/server/src/domains/__tests__/atomic-file-user-config.test.ts` cover the link, dangling link, and non-regular target.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** Hook installation edits the link target in place; a dangling link fails with CONFLICT instead of creating a file.

### AD-privacy-diagnostic-settings-denylist: [RESOLVED · Confirmed defect · S]

- **Summary:** Export Diagnostics copied settings verbatim except for a denylist, so private delegation instructions and a split `--api-key <value>` launch argument reached the bundle.
- **Evidence:** `apps/server/src/domains/diagnostic-settings.ts:22-25` projects every `AppSettings` key through a mapped-type allowlist; free text exports only its length, and argv and command lines go through `redactArgv` and `redactCommandLine` (`packages/utils/src/redaction.ts:79-91`), which Process Explorer now shares.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** A new settings key without a declared projection is a type error; the export never contains free-text instructions or flag-pair secrets.

### AD-lifecycle-chat-process-group-reap: [RESOLVED · Confirmed defect · S]

- **Summary:** When a Chat provider exited or crashed on its own, background tools the Agent had started (a dev server, a watcher) survived in its process group, and stopping a Chat could wait on stdio a surviving member held open.
- **Evidence:** `apps/server/src/domains/agent-chat/provider-process.ts` `reapGroup` reaps the group as soon as the leader exits and bounds `terminate()`; `apps/server/src/domains/agent-chat/__tests__/provider-process.integration.test.ts` covers self-exit, a TERM-ignoring member, and a held stdout.
- **First seen:** 2026-10-10 @ daf68990 (independent verification) · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** No provider group member outlives the leader by more than two grace periods, and termination never waits on a surviving member's stdio.

### AD-lifecycle-archive-launch-race: [RESOLVED · Confirmed defect · S]

- **Summary:** Archiving a Session while one of its Terminals was still starting (a restore on selection, a slow shell, or an Agent launch) left that PTY running unseen in the archived Session, counted by the close prompt, with nothing left to suspend it.
- **Evidence:** `apps/server/src/domains/parking-handlers.ts` `parkSessions` awaits in-flight restores before suspending, and `apps/server/src/domains/terminal/suspension.ts` `parkLaunch` parks a Terminal whose Host start lands after its Session was archived or its Project hidden; `apps/server/src/domains/__tests__/session-archive-launch.integration.test.ts` covers both windows.
- **First seen:** 2026-10-10 @ c0046f78c (fix-batch verification) · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** A Host start that answers after the archive ends `suspended` with no live process.

### AD-lifecycle-project-hide-chats: [RESOLVED · Confirmed defect · S]

- **Summary:** Hiding a Project suspended its PTYs but left its Agent Chats running, still counted by the close prompt and Server Core's idle-exit check.
- **Evidence:** `apps/server/src/domains/project/hiding-handlers.ts` routes `project.hide` through the shared `parkSessions` under the Project and Session locks; `project-hiding.integration.test.ts` asserts the live count drops to zero.
- **First seen:** 2026-10-10 @ c0046f78c (fix-batch verification) · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** Archive and hide share one parking path, so neither leaves a process the other stops.

### AD-diag-git-cancel-as-exit: [RESOLVED · Coverage or observability gap · S]

- **Summary:** An aborted Git command was logged at warn as `git.command_failed reason=exit` and surfaced as a Git failure, misleading Logs triage during fast Source Control navigation.
- **Evidence:** `apps/server/src/domains/git/errors.ts` classifies it as `cancelled`, logs it at debug, and maps it to `CANCELLED`; `command-failure-log.integration.test.ts` covers it.
- **First seen:** 2026-10-10 @ c0046f78c (fix-batch verification) · **Last verified:** 2026-10-11 with the fix batch
- **Resolved:** 2026-10-11 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** A cancellation never reads as a Git exit failure.

### AD-perf-archived-session-caches: [RESOLVED · Architecture debt · S]

- **Summary:** Archiving a Session kept its Git trackers, watchers, and snapshots alive, and those references could bypass the 16-watcher LRU cap.
- **Evidence:** `apps/server/src/domains/parking-handlers.ts` `parkSessions` evicts the parked Sessions' caches on archive and Project hide; `apps/server/src/domains/__tests__/session-archive-caches.integration.test.ts` covers it.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** Archive releases every per-Session cache entry; restore rebuilds them on demand.

### AD-domain-flat-family-modules: [RESOLVED · Architecture debt · M]

- **Summary:** `apps/server/src/domains/` accumulated flat file families beside same-named domain directories, and nothing stopped new ones.
- **Evidence:** `apps/server/src/domains/__tests__/structure.test.ts` adds two ratchets with frozen allowlists (`preexistingFlatModulesBesideTheirDomain`, `preexistingFlatFamilyModules`), and `.agents/skills/project-architecture/references/packages.md` states the placement rule. Folding the frozen families into directories is a separate follow-up.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620) (ratchet; existing families tracked separately).
- **Remediation target / Acceptance:** A new flat module beside its domain directory, or a new flat family without a base, fails the structure test.

### AD-ext-provider-silent-fallback: [RESOLVED · Architecture debt · M]

- **Summary:** A new provider compiled cleanly but silently inherited another provider's usage parser, context-cache inspector, hook turn key, and mobile timeline support.
- **Evidence:** Exhaustive `Record<AgentProvider, ...>` tables in `apps/server/src/domains/usage/parsers.ts`, `apps/server/src/domains/agents/context-cache.ts`, `apps/server/src/domains/agents/hooks/bridge.ts` (`HOOK_TURN_ID_KEYS`), and `apps/mobile/src/features/sessions/session-ui-state.ts` (`CONVERSATION_TIMELINE_PROVIDERS`).
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** Adding a provider ID fails typecheck until each table declares its behavior.

### AD-test-chat-driver-catalog-parity: [RESOLVED · Coverage or observability gap · S]

- **Summary:** Chat support was declared in both the provider catalog and the driver table with no parity check, and a mismatch surfaced as a misleading `spawn_failed`.
- **Evidence:** `apps/server/src/domains/agent-chat/__tests__/chat-drivers.test.ts` locks the driver table to the catalog's Chat-capable providers.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** The two declarations cannot diverge without a failing test.

### AD-owner-duplicate-trash: [RESOLVED · Architecture debt · S]

- **Summary:** Move to Trash had two complete implementations, and the Server one was reachable only from tests.
- **Evidence:** The Server path is gone from `apps/server/src/core/desktop-router.ts` and `packages/protocol/src/transport/local-transport.ts`; Main's `files.trash` is the only owner.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** One Trash implementation, owned by Main.

### AD-sec-hand-written-bounded-reads: [RESOLVED · Architecture debt · M]

- **Summary:** Several user-file reads reimplemented the bounded reader by hand, and some opened without `O_NONBLOCK`, so a FIFO at that path hung the read.
- **Evidence:** `packages/system/src/filesystem/bounded-file-reader.ts` (then under Server domains) gains `symlinks` and `inspect` options; `config/source.ts`, `claude/metadata-cache.ts`, `grok/state.ts`, `core/extensions/discovery.ts`, `catalog.ts`, and `core/private-json-store.ts` now use it, with FIFO tests.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Changed-shape recurrence:** 2026-10-21 @ 403f8de9a, the Chat image picker in Desktop Main read with `stat` then `readFile`. Fixed in [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264): the reader moved to `packages/system/src/filesystem/bounded-file-reader.ts` and `apps/desktop/src/main/agent-chat/path-picker.ts` uses it; covered by `apps/desktop/src/main/agent-chat/__tests__/path-picker.test.ts`.
- **Changed-shape recurrence:** 2026-10-26 @ c23b63b9d, live usage read the Claude subagent `.meta.json` with no size cap (Chat reads the same file under 64 KiB), the Grok `.cwd` marker had two hand-written readers, and Project Status and four Acceptance fixtures read by hand. Fixed via [issue caxri#2601](https://github.com/tjx666/caxri/issues/2601): `readClaudeSubagentToolUseId` and `readGrokCwdMarker` in the provider `paths.ts` modules serve every caller, `project-status/external.ts` uses the shared reader, and `apps/desktop/src/main/acceptance-fixtures/fixture-io.ts` owns fixture command reads and receipt appends (`usage/__tests__/live-usage.test.ts`). The CLI, `@caxri/client`, and `@caxri/agent-skills` copies need a package-dependency decision: [issue caxri#2605](https://github.com/tjx666/caxri/issues/2605). Readers that check identity or TOCTOU, and the Worker-bundled copy, stay on purpose.
- **Remediation target / Acceptance:** A FIFO at any migrated path fails fast as a non-regular file.

### AD-lifecycle-quit-prompt-parent: [RESOLVED · Confirmed defect · S]

- **Summary:** Quitting with unsent review comments showed a detached app-modal dialog instead of a sheet on the Workbench window, because the prompt captured `mainWindow` before it was assigned.
- **Evidence:** `apps/desktop/src/main/app-quit.ts` `createAppQuitPromptOptions(dialog, getWindow)` resolves the window at prompt time; `apps/desktop/src/main/__tests__/app-quit.test.ts` covers it.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** The quit prompt attaches to the current Workbench window.

### AD-privacy-git-failure-log: [RESOLVED · Contract drift · S]

- **Summary:** `git.command_failed` promised no paths or refs but logged the full argv and stderr.
- **Evidence:** `apps/server/src/domains/git/command.ts`, `git/pull-request-merge.ts`, and `git/github.ts` log closed reason, exit code, and signal fields only; `apps/server/src/domains/git/__tests__/command-failure-log.integration.test.ts` covers it.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** A failing Git command's log carries no argv, path, ref, or stderr text.

### AD-persist-schema-migration-drift-guard: [RESOLVED · Coverage or observability gap · S]

- **Summary:** Nothing detected a `schema.ts` change without its generated migration, while the schema comment claimed it was enforced.
- **Evidence:** `apps/server/src/domains/db/__tests__/schema-migration-drift.test.ts` diffs the schema against the migration snapshot in memory through `drizzle-kit/api`.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** A schema edit without its migration fails the unit suite.

### AD-contract-external-document-read-only: [RESOLVED · Contract drift · S]

- **Summary:** Architecture references and ADR 0007 still described an external document as a read-only snapshot after it became saveable and able to open a Terminal whose cwd persists.
- **Evidence:** [ADR 0013](adr/0013-editable-external-documents.md) amends ADR 0007; `.agents/skills/project-architecture/references/security.md` and `product-model.md` describe the registry authority and the persisted cwd.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** Every reference matches shipped external-document behavior.

### AD-contract-project-registration-authorities: [RESOLVED · Contract drift · S]

- **Summary:** The security reference omitted two Project registration authorities: mobile `project.add` and Caxri Bot system Project.
- **Evidence:** `.agents/skills/project-architecture/references/security.md` lists every path that registers a Project.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** A new registration path has one named home to be added to.

### AD-ext-mobile-provider-labels: [RESOLVED · Contract drift · S]

- **Summary:** Mobile showed "Grok" from three hand-written label tables while Desktop showed the catalog's "Grok Build".
- **Evidence:** `apps/mobile/src/features/sessions/session-row-model.ts`, `new-session-model.ts`, and `apps/mobile/src/features/agent-chat/agent-chat-model.ts` read `agentProviderCatalog[kind].displayName`.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** Mobile and Desktop show the same provider names.

### AD-contract-cli-skill-providers: [RESOLVED · Contract drift · S]

- **Summary:** The CLI reference said skill installation supported only Codex and Claude after Grok Build was added.
- **Evidence:** `.agents/skills/project-architecture/references/cli.md` points at `packages/agent-skills/src/provider-policy.ts` as the provider list.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** The reference names the owning policy instead of a copied list.

### AD-ui-bot-editable-shortcuts: [RESOLVED · Contract drift · S]

- **Summary:** Caxri Bot window hand-copied which Terminal commands run inside editable fields, with no parity test.
- **Evidence:** `apps/desktop/src/renderer/src/features/caxri-bot/bot-shortcuts.ts` exports `BOT_KEYBOARD_COMMANDS`, locked by `bot-shortcuts.test.ts`.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** A drift between the copy and the command catalog fails the test.

### AD-toolchain-mobile-ts6: [RESOLVED · Contract drift · S]

- **Summary:** Mobile typechecks with TypeScript 6, which the toolchain references did not describe.
- **Evidence:** `.agents/skills/project-architecture/references/stack-baseline.md` and `electron-toolchain.md` document the Expo exception; `scripts/__tests__/toolchain-contract.test.ts` asserts it.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** The documented and tested toolchain matches the mobile package.

### AD-contract-conversation-term: [RESOLVED · Contract drift · S]

- **Summary:** Mobile's "Conversation" segment used a term the glossary listed only as an alias to avoid.
- **Evidence:** `GLOSSARY.md` defines **Conversation** as a read view of one Agent Session.
- **First seen:** 2026-10-10 @ daf68990 · **Last verified:** 2026-10-10 @ c0046f78c with the fix batch
- **Resolved:** 2026-10-10 via [issue caxri#1620](https://github.com/tjx666/caxri/issues/1620).
- **Remediation target / Acceptance:** The glossary defines the term the product shows.

### AD-lifecycle-agent-endpoint-generation-map: [RESOLVED · Architecture debt · S]

- **Summary:** `AgentEndpointRegistry` no longer retains a generation counter for permanently deleted Terminals; restart retirement still preserves the monotonic generation for a live Terminal.
- **Evidence:** `apps/server/src/core/agent-endpoints/registry.ts:281` deletes the generation entry on permanent retirement, and the `forgetGenerationsWhere` pass at `apps/server/src/core/agent-endpoints/registry.ts:176-178` reclaims matching entries when a Session or Project is forgotten.
- **First seen:** 2026-08-15 @ 43af4d6 · **Last verified:** 2026-08-16 @ 19474c0
- **Resolved:** 2026-08-16 @ 19474c0 via [PR caxri#187](https://github.com/tjx666/caxri/pull/187).
- **Remediation target / Acceptance:** Permanent Terminal/Session/Project deletion reclaims generation state while a live Terminal restart keeps its monotonic generation. Tracked by [issue caxri#172](https://github.com/tjx666/caxri/issues/172).

### AD-lifecycle-stale-desktop-sockets: [RESOLVED · Confirmed defect · S]

- **Summary:** Replacing the authenticated Desktop now actively disconnects the previous socket after rejecting its pending commands and revoking its lease, so repeated replacements keep socket and client accounting bounded.
- **Evidence:** `apps/server/src/core/control-server.ts:469-476` revokes the replaced Desktop's authority and destroys its socket during lease replacement.
- **First seen:** 2026-08-15 @ 43af4d6 · **Last verified:** 2026-08-16 @ 19474c0
- **Resolved:** 2026-08-16 @ 19474c0 via [PR caxri#187](https://github.com/tjx666/caxri/pull/187).
- **Remediation target / Acceptance:** After rejecting pending commands and revoking authority, a replaced Desktop is actively disconnected while the new Desktop retains exclusive authority. Tracked by [issue caxri#173](https://github.com/tjx666/caxri/issues/173).

### AD-perf-agent-inbox-duplicate-window: [RESOLVED · Architecture debt · S]

- **Summary:** Peer Inbox duplicate fingerprints are now bounded by a fixed capacity in addition to the 30-second TTL, so distinct invalid targets can no longer grow duplicate state without limit.
- **Evidence:** `apps/server/src/core/agent-inbox/registry.ts:373-376` evicts the oldest duplicate records at `MAX_DUPLICATES` capacity while the TTL sweep continues to prune expired entries.
- **First seen:** 2026-08-15 @ 43af4d6 · **Last verified:** 2026-08-16 @ 19474c0
- **Resolved:** 2026-08-16 @ 19474c0 via [PR caxri#187](https://github.com/tjx666/caxri/pull/187).
- **Remediation target / Acceptance:** A fixed duplicate-window capacity preserves in-window retry behavior without changing authorization or delivery semantics. Tracked by [issue caxri#174](https://github.com/tjx666/caxri/issues/174).

### AD-lifecycle-mutation-remap-origin-delete: [RESOLVED · Confirmed defect · M]

- **Summary:** Deleting the Session that started a completed rename/move no longer lets the durable journal disappear before sibling same-Project state is remapped.
- **Evidence:** `apps/desktop/src/renderer/src/features/view-containers/resource-explorer/file-operation-reconciliation.ts` resolves the operation by `workbenchProjectId`, durably remaps every surviving same-Project Session, and acknowledges through the controlled extension provider only after apply succeeds. `apps/desktop/src/renderer/src/stores/selectors.ts` discovers those Sessions by Project identity.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-14 @ 2b8da83.
- **Remediation target / Acceptance:** A and B open the same file; move it from A; delete A before ack; B's tab, dirty buffer, and later reload show the new path; the operation is not acked while B still needs the remap.

### AD-sec-packaged-renderer-url: [RESOLVED · Architecture debt · S]

- **Summary:** Packaged workbench and Process Explorer windows cannot load an environment-supplied Renderer origin.
- **Evidence:** `apps/desktop/src/main/renderer-entry.ts:20-34` honors `ELECTRON_RENDERER_URL` only when unpackaged and otherwise resolves an application-bundle file URL. `apps/desktop/src/main/__tests__/renderer-entry.test.ts:9-77` covers both windows and both modes.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ 3903e7e via [issue caxri#166](https://github.com/tjx666/caxri/issues/166).
- **Remediation target / Acceptance:** Packaged mode ignores `ELECTRON_RENDERER_URL`; unpackaged development mode retains it.

### AD-sec-hook-config-size-cap: [RESOLVED · Architecture debt · S]

- **Summary:** Provider-owned Agent lifecycle-hook configuration is bounded before any adapter receives or parses it.
- **Evidence:** `apps/server/src/domains/agents/hooks/manager.ts:175-184` reads provider targets through the shared bounded regular-file reader with a 1 MiB limit. `apps/server/src/domains/agents/hooks/__tests__/manager.integration.test.ts:440-486` proves an oversized file is neither parsed nor rewritten.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ e1c5948
- **Resolved:** 2026-08-15 @ b6fe27c and bdd1806 via [issue caxri#167](https://github.com/tjx666/caxri/issues/167).
- **Remediation target / Acceptance:** Oversized provider configuration fails closed without parsing or rewriting the file; supported bounded files continue to reconcile.

### AD-sec-theme-import-bounded-read: [RESOLVED · Confirmed defect · S]

- **Summary:** Theme import now reads through one regular-file handle into a fixed-size buffer and rejects growth before format sniffing or parsing, while preserving final-symlink compatibility for user-owned theme and provider configuration files.
- **Evidence:** `packages/system/src/filesystem/bounded-file-reader.ts` reads at most `maxBytes + 1` through one handle and rejects non-regular or overflowing sources. `apps/server/src/domains/theme/importer.ts` uses that boundary; `apps/server/src/domains/theme/__tests__/theme.test.ts` covers final symlinks, post-open growth, and FIFO rejection.
- **First seen:** 2026-08-13 @ 63a7ccc · **Last verified:** 2026-08-15 @ e1c5948
- **Resolved:** 2026-08-15 @ b6fe27c and bdd1806 via [issue caxri#167](https://github.com/tjx666/caxri/issues/167).
- **Remediation target / Acceptance:** No parser receives more than 1 MiB; post-open growth returns `CAPACITY`, pathname replacement cannot redirect the opened handle, and normal supported imports continue to succeed.

### AD-state-sibling-session-invalidation: [RESOLVED · Confirmed defect · M]

- **Summary:** Project-shared filesystem and Git facts now invalidate every same-Project Session, including a sibling selected during a queued watcher batch.
- **Evidence:** Server Core emits scope-bound `files.changed` events; `apps/desktop/src/renderer/src/queries/invalidation.ts` invalidates Core Resource Explorer reads for every same-Project Session without an Extension Host echo. `apps/server/src/domains/files/__tests__/watcher.scope.integration.test.ts` covers queued rebind and cross-Project fencing.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ 660ef29 via [issue caxri#168](https://github.com/tjx666/caxri/issues/168).
- **Remediation target / Acceptance:** Two Sessions sharing one Project observe matching `files.list` and `git.summary` after an external write and immediate Session switch; another Project remains untouched.

### AD-ui-secondarySidebar-show-reveal: [RESOLVED · Contract drift · S]

- **Summary:** Catalogued SecondarySidebar Show commands and Search Files now reveal a hidden SecondarySidebar before selecting their target mode.
- **Evidence:** `apps/desktop/src/renderer/src/commands/execute.ts:49-57` owns the reveal-and-activate boundary; command registrations use it at `apps/desktop/src/renderer/src/commands/execute.ts:135-147`. `apps/desktop/src/renderer/src/commands/execute.test.ts` covers all registered Show commands and Search Files.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ b6826f5 via [issue caxri#169](https://github.com/tjx666/caxri/issues/169).
- **Remediation target / Acceptance:** With the SecondarySidebar hidden, each Show command and its default binding makes the requested panel visible without rewriting an already-visible layout.

### AD-ext-e2e-provider-shims: [RESOLVED · Architecture debt · S]

- **Summary:** Caxri-owned E2E executable environment keys and blocked Shell shims derive from the managed Agent provider catalog.
- **Evidence:** `packages/system/src/testing/agent-policy.ts:36-41` derives provider environment keys, and `packages/system/src/testing/agent-policy.ts:96-105` builds every provider shim from `agentProviderIds`. `packages/system/src/testing/__tests__/agent-policy.test.ts` locks catalog coverage.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-14 @ 75ed0f4 as part of [PR caxri#138](https://github.com/tjx666/caxri/pull/138).
- **Remediation target / Acceptance:** Adding a managed provider automatically yields its fake-executable environment key and blocked shim, with an exhaustive focused test.

### AD-ext-public-git-diff: [RESOLVED · Architecture debt · S]

- **Summary:** The obsolete raw-string `git.diff` operation is no longer part of the public protocol or domain handler table.
- **Evidence:** `packages/protocol/src/registry/methods.ts:552-568` exposes only typed diff documents. `packages/protocol/src/__tests__/index.test.ts:227-253` proves Desktop negotiation omits `git.diff` and public request parsing rejects it.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ e7489de via [issue caxri#170](https://github.com/tjx666/caxri/issues/170).
- **Remediation target / Acceptance:** `git.diffDocument` and `git.pullRequestDiffDocument` remain the bounded public diff reads; `git.diff` cannot negotiate or parse.

### AD-perf-pr-cache-unbounded: [RESOLVED · Architecture debt · S]

- **Summary:** Pull Request metadata caching now has TTL pruning, a fixed LRU capacity, deletion eviction, and shutdown cleanup.
- **Evidence:** `apps/server/src/domains/git/pull-request.ts:161-188` implements Session eviction, clear, expiry pruning, and a 128-entry LRU. `apps/server/src/domains/create-domain-services.ts:535-548,628-633` evicts Project and Session keys. `apps/server/src/domains/git/__tests__/pull-request.test.ts:73-202` covers expiry, capacity, deletion, collision, and in-flight invalidation.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ e7489de via [issue caxri#170](https://github.com/tjx666/caxri/issues/170).
- **Remediation target / Acceptance:** Historical Session/repository entries stay bounded, deleted Sessions cannot repopulate the cache, and unrelated identifiers cannot collide.

### AD-ui-work-tab-tablist: [RESOLVED · Confirmed defect · M]

- **Summary:** Open Work now implements automatic keyboard activation, roving focus, an actual active tabpanel association, and a text alternative for dirty state.
- **Evidence:** `apps/desktop/src/renderer/src/features/tabs/work-tab-strip.tsx:298-318` implements Arrow, Home, and End navigation. `apps/desktop/src/renderer/src/features/tabs/work-tab.tsx` owns tab semantics and the dirty-state description. `e2e/editor-tabs.e2e.ts` covers mixed Terminal/editor keyboard and accessibility behavior, including preserving roving focus after Terminal attachment.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ e1c5948
- **Resolved:** 2026-08-15 @ 43af4d6 via [issue caxri#171](https://github.com/tjx666/caxri/issues/171).
- **Remediation target / Acceptance:** Arrow/Home/End changes and focuses the active work target, one tab participates in sequential focus, the active surface is associated, and unsaved state has a screen-reader description.

### AD-persist-non-atomic-document-save: [RESOLVED · Confirmed defect · M]

- **Summary:** Editor save truncates then overwrites in place with no atomic rename or mutation journal, so a crash mid-save can permanently empty or truncate the user's file.
- **Evidence:** `apps/server/src/domains/files/documents.ts:122-203` writes and syncs a same-directory `O_NOFOLLOW` replacement, revalidates its identity and containment, atomically renames it, syncs the directory, and cleans up only the trusted inode. `apps/server/src/domains/files/__tests__/documents.test.ts:53-203` covers complete replacement, interrupted writes, swapped parents, and safe cleanup.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 85cbbd1 via [issue caxri#75](https://github.com/tjx666/caxri/issues/75) (initial implementation 99f533a; containment hardening d3e4540 and 85cbbd1).
- **Remediation target / Acceptance:** Atomic replace for `files.write` (same-dir temp write + fsync + rename) or journaled save. Acceptance: kill Server Core mid-save never leaves a permanently empty file that previously had content; user gets old full bytes or new full bytes. Regression covers crash-between-truncate-and-write.

### AD-sec-config-disk-size-cap: [RESOLVED · Architecture debt · S]

- **Summary:** Settings/keybindings/theme disk load and hot-reload read and parse without a pre-parse size cap, while IPC update and theme import already bound sources, so an oversized userData config can inflate Server memory and cross-process event/get payloads.
- **Evidence:** `packages/protocol/src/configuration/configuration-contract.ts` owns the bounded source and keybinding limits. `apps/server/src/domains/config/service.ts` performs bounded reads before parsing; protocol registry and event schemas reuse the same contracts. `apps/server/src/domains/__tests__/configuration.test.ts` and `packages/protocol/src/__tests__/contracts.test.ts` cover startup, hot reload, and protocol rejection.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 40d6d13 via [issue caxri#76](https://github.com/tjx666/caxri/issues/76).
- **Changed-shape recurrence:** 2026-10-21 @ 403f8de9a, SSH Host first-connect seeding read the three sources unbounded. Fixed in [PR caxri#2264](https://github.com/tjx666/caxri/pull/2264): `apps/desktop/src/main/ssh/seed-config.ts` reads each through the shared cap; covered by `apps/desktop/src/main/ssh/__tests__/seed-config.test.ts`.
- **Remediation target / Acceptance:** Shared max for settings/keybindings/theme sources enforced on disk load, hot-reload, and IPC; bound event/result `source` (and keybindings array growth) to the same ceiling. Acceptance: oversized userData config keeps prior valid state, does not emit/get multi-cap sources; focused unit test fails if the size gate is removed.

### AD-state-dual-editor-dirty: [RESOLVED · Architecture debt · M]

- **Summary:** Editor dirtiness is dual-written to Renderer document cache and durable `openTabs[].dirty` without content, so after crash/relaunch a tab can stay durable-dirty while content is clean disk and preview rules still treat it as dirty.
- **Evidence:** `apps/desktop/src/shared/editor-state.ts:34-51` normalizes durable tabs clean and rehydrates transient dirtiness only from live documents. `apps/server/src/domains/db/models/sessions.ts:149-151` removes legacy/persisted dirty flags, while `apps/desktop/src/renderer/src/stores/workbench.ts:63-64,206` reconciles live cache state but persists clean metadata. Regression coverage lives at `apps/server/src/domains/db/__tests__/database.integration.test.ts`, `apps/desktop/src/renderer/src/stores/workbench.test.ts:148-218`, and `apps/desktop/src/renderer/src/features/editor/document-commands.test.ts:105-184`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ d2b3502 via [issue caxri#77](https://github.com/tjx666/caxri/issues/77).
- **Remediation target / Acceptance:** Single dirty source of truth, or clear durable `openTabs.dirty` on bootstrap/open when no recoverable draft content exists. Acceptance: no path leaves `openTabs.dirty=true` without live dirty content or a recoverable draft; UI dots and preview rules agree.

### AD-domain-runtime-index-boundary: [RESOLVED · Architecture debt · M]

- **Summary:** Nested Server domains `files/` and `agents/` lack `index.ts` public surfaces while production and cross-domain code deep-import internals, so Agents cannot predict import boundaries.
- **Evidence:** `apps/server/src/domains/agents/index.ts` and `apps/server/src/domains/files/index.ts` expose the public surfaces; current production consumers import their domain roots. `apps/server/src/domains/__tests__/structure.test.ts:54-92` independently requires barrels for domains with at least three modules and rejects cross-domain deep imports.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 310f068 via [issue caxri#78](https://github.com/tjx666/caxri/issues/78).
- **Remediation target / Acceptance:** Domain `index.ts` barrels for files and agents; production imports only through those surfaces; Terminal launch resolve via public Agents (or executables) export. Acceptance: production Server imports of nested domains resolve only through each domain's `index.ts`.

### AD-ext-agent-display-single-source: [RESOLVED · Architecture debt · S]

- **Summary:** Adding a hosted Agent provider is not one catalog+adapter path: default Terminal titles and hosted icon labels re-declare display strings outside `agentProviderCatalog`.
- **Evidence:** `apps/server/src/domains/db/session-policy.ts:24-25` and `apps/desktop/src/renderer/src/icons/agents/agent-icon-registry.ts:26-28` derive managed-provider titles and labels from `packages/protocol/src/agent/agents.ts`. Exhaustive catalog coverage lives at `apps/server/src/domains/db/__tests__/session-policy.test.ts:57-66` and `apps/desktop/src/renderer/src/icons/agents/agent-icon-registry.test.ts:8-21`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 58ebede via [issue caxri#79](https://github.com/tjx666/caxri/issues/79).
- **Remediation target / Acceptance:** Derive default agent Terminal titles (shell remains local) and hosted icon labels from the catalog, or add bi-directional exhaustiveness tests. Acceptance: catalog id + providers registry is enough for default title and displayName consumers; extra icon assets stay the only optional UI step.

### AD-test-runtime-scale-rule-gate: [RESOLVED · Coverage or observability gap · S]

- **Summary:** The Server domain scale / `index.ts` boundary is documented but has no test, lint, or knip gate, so boundary drift stays green under typecheck.
- **Evidence:** `apps/server/src/domains/__tests__/structure.test.ts:54-92` scans direct Server domains, requires `index.ts` at the scale threshold, parses production imports, and rejects cross-domain paths below a domain root. The focused structure test still passes on `main@8037720`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 310f068 via [issue caxri#78](https://github.com/tjx666/caxri/issues/78).
- **Remediation target / Acceptance:** Cheap structure test or eslint/knip boundary rule requiring nested-domain `index.ts` and forbidding production deep cross-domain imports. Acceptance: introducing missing domain `index.ts` or illegal deep imports fails a focused automated check.

### AD-persist-schema-version-hand-sync: [RESOLVED · Architecture debt · M]

- **Summary:** Schema evolution requires hand-keeping Drizzle SQL `?raw` imports, `preservingMigrations`, `CURRENT_SCHEMA_VERSION`, and `app_state.schemaVersion` in sync (drizzle journal meta numbering also diverges), so a missed edit can split fresh vs upgraded DBs.
- **Evidence:** `apps/server/src/domains/db/migrations/manifest.ts` validates the bundled SQL list against Drizzle's journal and derives the baseline and current versions. Since [issue caxri#1324](https://github.com/tjx666/caxri/issues/1324) squashed the pre-release chain into `0000_baseline`, `PRAGMA user_version` is the only stored version and `app_state.schemaVersion` is gone. `apps/server/src/domains/db/__tests__/migration-manifest.test.ts` rejects missing, reordered, or duplicate entries; `apps/server/src/domains/db/__tests__/database.integration.test.ts` covers fresh install, pre-baseline rebuild, and newer-version rejection.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 8301a1a via [issue caxri#81](https://github.com/tjx666/caxri/issues/81).
- **Remediation target / Acceptance:** Derive version and preserving list from migrations meta/journal; one writer for `user_version` and app-state; CI equality gate. Acceptance: new drizzle migration cannot ship without version advancement; upgrade-from-floor coverage remains.

### AD-ui-design-redline-drift: [RESOLVED · Contract drift · M]

- **Summary:** Authoritative DESIGN type/spacing/radius redlines are already violated in chrome primitives and are not lint-enforced, so interaction density drifts by ad-hoc Tailwind literals.
- **Evidence:** `DESIGN.md:25-78` now defines dense type, optical spacing, control-height, radius, platform exceptions, and the closed arbitrary-value policy. `apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts:10-142` recognizes typography, control-height, positive/negative spacing, and radius classes before enforcing the explicit allowlist; it still passes on `main@8037720`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 1e77c5c via [issue caxri#82](https://github.com/tjx666/caxri/issues/82).
- **Remediation target / Acceptance:** Normalize chrome to meta/base and the 4px grid, or revise DESIGN to admit the dense set; optional ESLint/Tailwind ban for off-contract classes. Acceptance: no Renderer class uses banned sizes/spacings/radii without an explicit DESIGN exception.

### AD-ui-dual-theme-css-bootstrap: [RESOLVED · Architecture debt · S]

- **Summary:** Main workbench and Process Explorer each own a full Tailwind `@theme` bootstrap, so semantic token additions must be dual-edited and already diverge.
- **Evidence:** `apps/desktop/src/renderer/src/styles/theme.css:9-75` is the only semantic Tailwind/default-theme bootstrap. Both `apps/desktop/src/renderer/src/styles/styles.css:1` and `apps/desktop/src/renderer/src/styles/process-explorer.css:1` import it. `apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts:29-52` rejects another `@theme` source or an entry that stops importing the shared file.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ fba7662 via [issue caxri#83](https://github.com/tjx666/caxri/issues/83).
- **Remediation target / Acceptance:** Extract shared theme-bootstrap CSS (unregister + `@theme` + defaults); keep PE-only rules separate. Acceptance: adding a semantic token is a single edit consumed by both entries.

### AD-ui-input-primitive-bypass: [RESOLVED · Architecture debt · M]

- **Summary:** Shared Input encodes the field redline, but dense workbench surfaces reimplement raw `<input>` with different heights and focus treatment, fragmenting interaction chrome.
- **Evidence:** `apps/desktop/src/renderer/src/components/ui/input.tsx` owns `standard`, `dense`, `compact`, and `palette` sizes plus shared appearances and `InputGroup`. Resource Explorer, Project Search, Commit History, Project/Session rename, and Path Browser consume those variants. `apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts` rejects feature-local raw text inputs.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 1e77c5c via [issue caxri#82](https://github.com/tjx666/caxri/issues/82).
- **Remediation target / Acceptance:** Dense size (and optional adornment) variants on Input; migrate secondarySidebar/search/rename fields. Acceptance: feature-local text fields do not reinvent border/focus/radius; density is a prop on the shared primitive.

### AD-toolchain-shadcn-components-json: [RESOLVED · Contract drift · S]

- **Summary:** `components.json` still declares `baseColor: zinc` and a single CSS path, conflicting with the unregistered-default-palette guarantee and dual renderer CSS entries.
- **Evidence:** `components.json:8-9` now points shadcn at the shared `apps/desktop/src/renderer/src/styles/theme.css`; `DESIGN.md:25-29` documents why immutable `baseColor: zinc` metadata does not re-enable the unregistered default palette. `apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts:55-67` locks both properties to the intentional contract.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ fba7662 via [issue caxri#83](https://github.com/tjx666/caxri/issues/83).
- **Remediation target / Acceptance:** Align `components.json` with semantic tokens and shared theme CSS; document PE dual-entry handling. Acceptance: project-guided shadcn add does not reintroduce palette utilities or leave PE bootstrap stale.

### AD-lifecycle-pe-render-recovery: [RESOLVED · Coverage or observability gap · S]

- **Summary:** Process Explorer has no React ErrorBoundary and no Main `render-process-gone` crash-policy, so a PE render throw or renderer crash blanks the diagnostic window without workbench-style recovery.
- **Evidence:** `apps/desktop/src/renderer/src/process-explorer-main.tsx:6-18` wraps the diagnostic app in the shared recoverable `ErrorBoundary`. `apps/desktop/src/main/process-explorer-window.ts:97-124` applies bounded crash-policy reloads and stops a crash loop cleanly. `apps/desktop/src/main/__tests__/crash-policy.test.ts:5-44` covers the backoff budget; `e2e/process-explorer-recovery.e2e.ts:93-151` covers render reload and repeated renderer crashes on real Electron.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ bd4f813 via [issue caxri#84](https://github.com/tjx666/caxri/issues/84).
- **Remediation target / Acceptance:** Reuse ErrorBoundary (or PE fallback) on the PE entry; optionally register Main crash recovery for the PE window. Acceptance: forced PE render throw shows recovery UI; process-gone does not leave an unrecovered blank PE indefinitely.

---

## STALE

### AD-test-hyphenated-sibling-discovery: [STALE · Coverage or observability gap · S]

- **Summary:** The original claim that `check --test` silently misses `project-status-runner.test.ts` is no longer true because static direct-import discovery includes that suite.
- **Evidence:** `.agents/skills/quality-check/scripts/check.ts` resolves Renderer aliases and scans static direct imports across applications, skills, scripts, and packages; `apps/server/src/domains/__tests__/project-status-runner.test.ts:3-4` directly imports `../project-status-external`. Exact-stem candidate generation remains intentionally narrower.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified stale:** 2026-08-24 @ 87b613a
- **Disposition:** Do not add broad hyphenated-sibling inference. The distinct alias-import and `apps/cli` discovery gaps remain tracked by [issue caxri#159](https://github.com/tjx666/caxri/issues/159).

---

## Intentional tradeoffs (not debt: do not "fix" without product change)

Recorded so repeat audits do not reclassify them as findings.

| ID                                  | Tradeoff                                                                                                                                                                                                                                                                                                             | Evidence                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| IT-disk-wins-dirty-buffer           | External disk changes replace dirty editor buffers without a conflict dialog                                                                                                                                                                                                                                         | architecture / `external-sync`                                                                     |
| IT-unsaved-buffers-not-durable      | Document bodies stay Renderer-local; SQLite holds tab metadata only                                                                                                                                                                                                                                                  | `session_state` / session-view                                                                     |
| IT-terminal-snapshot-finalization   | Parsed snapshot encoding 3 persists its source grid; unclean Server Core loss may drop latest visual state                                                                                                                                                                                                           | `apps/server/src/domains/terminal/snapshot-persistence.ts`, TerminalManager                        |
| IT-copy-not-journaled               | `files.copy` is best-effort, may leave partial trees, Main wait non-expiring; create/rename/move are journaled                                                                                                                                                                                                       | `packages/protocol/src/transport/request-lifetime.ts`, `mutation-journal`, partial-copy tests      |
| IT-project-status-fixed-allowlist   | Project Status external CLIs are the closed `ExternalStatusSource` set (gh, git, lh, linear, vc); not a plugin adapter surface                                                                                                                                                                                       | `apps/server/src/domains/external-status/command.ts`, `apps/server/src/domains/project-status/`    |
| IT-pe-flag-redaction-only           | Process Explorer redacts common credential **flag** argv shapes only (best-effort); not full `redactSecretText`                                                                                                                                                                                                      | `process-explorer.ts` `redactProcessName`                                                          |
| IT-cli-global-wrapper               | Global CLI linking registers a dependency-free wrapper around the verified standalone bundle, because pnpm 12 stable cannot globally register the CLI workspace directly (absorbs the former duplicate `IT-pnpm-12-global-resolver` row)                                                                             | `apps/cli/scripts/link-global.ts`                                                                  |
| IT-typescript-6-eslint-plus-7-tsc   | typescript package aliases TS6 for eslint; `@typescript/native` supplies TS7 tsc                                                                                                                                                                                                                                     | electron-toolchain / stack-baseline                                                                |
| IT-electron-vite-beta               | electron-vite 6 beta accepted for Vite 8 + utilityProcess                                                                                                                                                                                                                                                            | package.json, electron-toolchain.md                                                                |
| IT-runtime-integration-not-inferred | `check` does not map every `apps/server/src/domains/*.ts` edit onto the top-level `domain-services.integration.test.ts` suite                                                                                                                                                                                        | `check.ts`, `check.test.ts` (flat domain file mapping case)                                        |
| IT-window-level-error-boundary      | Render exceptions recover via a window-level ErrorBoundary plus reload; only the editor pane nests one, so a failed lazy tab stays in its pane while a Terminal or Agent Chat pane throw reloads the window; a repeated throw on one Session moves the window to another Session (`AD-ui-render-crash-session-loop`) | `error-boundary.tsx`, Renderer entries, `editor-error-boundary.tsx`, `render-crash-recovery.ts`    |
| IT-eslint-renderer-import-gate      | Renderer Node/Electron isolation is ESLint `no-restricted-imports` plus sandbox, not a bundle AST walk                                                                                                                                                                                                               | `eslint.config.ts`, `BrowserWindow` webPreferences                                                 |
| IT-ci-workflow-source-contract      | Ordinary workflow contracts use source-shape/order smoke assertions; trust clauses have structured YAML binding, and neither layer evaluates arbitrary GitHub expression equivalence                                                                                                                                 | `ci-workflow-contract.test.ts`, `ci-trust-policy.test.ts`                                          |
| IT-e2e-build-input-roots            | E2E build freshness uses audited coarse repository roots rather than parsing the Vite dependency graph; confirmed missing consumed roots are defects                                                                                                                                                                 | `e2e/support/build-freshness.ts`, [issue caxri#335](https://github.com/tjx666/caxri/issues/335)    |
| IT-e2e-worker-local-error-gate      | `E2EErrorGate` state is isolated per Playwright worker process; pool orchestration may use more than one worker                                                                                                                                                                                                      | `e2e/support/error-gate.ts`, `scripts/run-e2e-pools.ts`                                            |
| IT-e2e-parallel-safe-default        | Specs default to the three-worker `parallel-safe` pool; only `desktopExclusiveSpecs` entries with a closed reason stay on one worker, and mechanical capabilities are enforced by source derivation and at launch                                                                                                    | `e2e/support/pools.ts`, `docs/ci-performance.md`                                                   |
| IT-external-document-in-place-save  | Saving a file outside every Project overwrites it in place to keep its inode, mode, and extended attributes, so a crash mid-save can truncate it; Project saves stay atomic                                                                                                                                          | `apps/desktop/src/main/external-documents.ts`, [ADR 0013](adr/0013-editable-external-documents.md) |
| IT-bot-owner-reads                  | `bot.managedSessions` and `session.permissionAutoAllowStatus` are owner-only rather than project-scoped for Agent principals; handlers carry no principal context and no Agent consumer exists                                                                                                                       | `packages/protocol/src/transport/method-spec.ts`, `agent-messaging.md`                             |
| IT-updater-streamed-rename          | The Desktop updater streams the DMG to a temp file, verifies hash and size, then renames it itself instead of using `atomicWriteFile`, which takes in-memory data                                                                                                                                                    | `apps/desktop/src/main/updates/updates.ts`                                                         |
| IT-guards-density-ratchet-subset    | `guards` runs only the about 1.4 s directory-density ratchet among whole-tree contract tests; `checks` still runs it and the slower workspace contract, so merging before `checks` finishes remains possible for those                                                                                               | `.github/workflows/guards.yml`, `scripts/run-ci-focused-checks.ts`                                 |

---

## Current priority guide (OPEN at 2026-10-26)

**Top priorities:** `AD-toolchain-electron-45-stable-pin` (unblocked) → `AD-lifecycle-chat-idle-providers` → `AD-layout-flat-family-enforcement` → `AD-contract-provider-literal-comparisons`.

## Historical priority guide (all resolved)

Retained to explain the original execution order used by [PR caxri#101](https://github.com/tjx666/caxri/pull/101).

**Top priorities:** `AD-persist-non-atomic-document-save` → `AD-sec-config-disk-size-cap` → `AD-state-dual-editor-dirty` → `AD-domain-runtime-index-boundary` + `AD-test-runtime-scale-rule-gate` → `AD-ext-agent-display-single-source`.

**Quick wins (S):** scale-rule gate · agent display single-source · shared theme CSS · `components.json` · PE ErrorBoundary · config disk size cap + tests.

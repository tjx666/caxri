# Architecture debt ledger

Persistent record of architecture-debt audit findings for revalidation across runs.
Maintained per `.agents/skills/audit-architecture-debt/references/debt-ledger.md`.

| Field            | Value                                                               |
| ---------------- | ------------------------------------------------------------------- |
| **First audit**  | 2026-08-11 @ `eb9becbee1f9c77d914fa6d113fa6084dba587b5` (`main`)    |
| **Last updated** | 2026-08-13 @ `940d949` (`main`)                                     |
| **Scope**        | Repository-wide audit at `main@940d949` after terminal-capabilities |

Statuses: `OPEN` · `RESOLVED` · `STALE`. Effort: S / M / L per the audit report format.
Category labels match the audit skill: Confirmed defect, Architecture debt, Contract drift,
Coverage or observability gap, Modernization opportunity, Intentional tradeoff.

---

## OPEN

### AD-lifecycle-mutation-remap-origin-delete — [OPEN · Confirmed defect · M]

- **Summary:** Deleting the Session that started a completed rename/move before acknowledge can leave sibling same-Project tabs and dirty buffers on the old path, then drop the durable journal.
- **Evidence:** `src/renderer/src/stores/selectors.ts:53-56` returns only `[originSessionId]` after the origin row is gone. `src/renderer/src/features/editor/document-actions.ts:279` treats a missing Session state as durable remap success. `src/renderer/src/features/inspector/panels/files/file-operation-reconciliation.ts:111-128` then acknowledges. `src/runtime/files/mutation-journal.ts:289-296` deletes the record unconditionally. `src/runtime/bootstrap.ts:578-585` `session.delete` does not remap remaining Sessions. `src/shared/ipc/domain.ts:324-368` stores `sessionId` only.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** Persist `projectId` (or remaining session ids) on the journal; resolve siblings from Project identity; do not ack until remaining Sessions remap or the Project is gone. Acceptance: A and B open the same file; move it from A; delete A before ack; B's tab, dirty buffer, and later reload show the new path; the operation is not acked while B still needs the remap.

### AD-sec-packaged-renderer-url — [OPEN · Architecture debt · S]

- **Summary:** A packaged process still honors `ELECTRON_RENDERER_URL`, so an env-supplied origin can load into a window that keeps the workbench or Process Explorer preload bridge.
- **Evidence:** `src/main/index.ts:362-363` branches only on env presence. `src/main/index.ts:731` and `src/main/process-explorer-window.ts:171-177` prefer the same env URL. `src/main/test-root.ts:27,41` already ignore `CAXRI_TEST_ROOT_PATH` when packaged.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** Ignore `ELECTRON_RENDERER_URL` when `app.isPackaged`, matching test-root. Acceptance: focused Main test — packaged + the variable does not select `loadURL`; unpackaged still does.

### AD-sec-hook-config-size-cap — [OPEN · Architecture debt · S]

- **Summary:** Agent lifecycle-hook reconcile reads and parses provider-owned config files with no pre-parse size cap, unlike settings, theme import, documents, and Claude metadata.
- **Evidence:** `src/runtime/agents/hooks/manager.ts:169` `readTargets()` `readFile`s every target unbounded. `manager.ts:338,517,531,546` parse on reconcile, watcher, and poll. `src/runtime/agents/hooks/json-config.ts:35`, `src/runtime/agents/providers/claude/hooks.ts:24`, and `src/runtime/agents/providers/codex/hooks.ts:19` jsonc/regex-parse the full string. Adjacent caps: `src/runtime/configuration.ts:167` (256 KiB), theme import 1 MiB, Claude metadata 128 KiB. Hook-manager tests have no oversized-config case.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** One shared hook-config byte ceiling in `readTargets` before any adapter parse; oversize fails closed without rewriting the file. Acceptance: a provider config just over the ceiling leaves hooks uninstalled/unmodified and does not parse; a focused hook-manager test fails if the cap is removed.

### AD-state-sibling-session-invalidation — [OPEN · Architecture debt · M]

- **Summary:** Project-shared filesystem and Git facts are cached per Session, but live disk events only invalidate the selected Session, so a sibling can reuse a still-fresh stale listing or `git.summary`.
- **Evidence:** `src/runtime/files/watcher.ts:167-170,354-361` tags `files.changed` with the selected `sessionId` only. `src/renderer/src/queries/invalidation.ts:21-40` and `src/renderer/src/features/inspector/panels/files/file-tree-refresh.ts:30-58` filter on that id. `src/renderer/src/queries/client.ts:26-30` default `staleTime` is 10s. `src/renderer/src/features/inspector/panels/files/file-actions.ts:24-34` already fans Caxri-owned `files.list` invalidation by Project.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** Fan out watcher invalidation of `files.list` and `git.*` to every Session of the changed Project, or include `projectId` on `files.changed`. Acceptance: two Sessions, one Project; write a file while A is selected; switch to B immediately; root listing and `git.summary` match disk.

### AD-ui-inspector-show-reveal — [OPEN · Contract drift · S]

- **Summary:** Catalogued Inspector "Show \*" commands persist a mode without revealing a hidden Inspector, while Search Files and the Status Bar do reveal it.
- **Evidence:** `src/shared/inspector.ts:8-36` titles/descriptions say show that mode in the Inspector. `src/renderer/src/commands/execute.ts:92-105` — `searchFiles` calls `setInspectorVisible(true)`, `setMode` does not. `src/renderer/src/features/status-bar/StatusBar.tsx:454-456` uncollapses then runs the same show command. `src/renderer/src/commands/execute.test.ts:118-126` locks setMode-only.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** One `activateInspectorMode(mode)` used by show commands, Search Files, and Status Bar that sets visibility and mode. Acceptance: with the Inspector hidden, each show command and its default binding makes that panel visible.

### AD-ext-e2e-provider-shims — [OPEN · Architecture debt · S]

- **Summary:** A new managed Agent provider is exhaustive in production catalogs but not on the Caxri-owned E2E isolation boundary, so fake executables and blocked Shell shims stay hard-coded to claude and codex.
- **Evidence:** `src/shared/node/e2e-agent-policy.ts:145-169` and `src/main/index.ts:93` encode/decode only the two env keys. `e2e/helpers.ts:143-154` writes shims named `claude` and `codex` only. Production `agentProviders` and icon assets remain `Record<AgentProvider, …>`.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** Derive `CAXRI_E2E_FAKE_<PROVIDER>_EXECUTABLE` and isolated Shell shims from `agentProviderIds`. Acceptance: adding a third `AgentProvider` id without updating those files fails a focused unit test; with the helper, a fake executable and blocked shim exist for the new id.

### AD-ext-public-git-diff — [OPEN · Architecture debt · S]

- **Summary:** `git.diff` remains a public Renderer-reachable method with an unbounded string result after the UI moved to bounded `git.diffDocument`.
- **Evidence:** `src/shared/ipc/methods.ts:470-477` registers public `z.string()`. `src/runtime/bootstrap.ts:679` still dispatches it. Production Renderer requests `git.diffDocument` only (`src/renderer/src/features/editor/GitDiffEditor.tsx:178,259`).
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** Remove `git.diff` from the public method table (keep `GitService.diff` for tests if needed) or move it to `internalMethods` and bound the result. Acceptance: `methods.ts` no longer exposes `git.diff` to Renderer; `git.diffDocument` remains the only public single-file diff read.

### AD-perf-pr-cache-unbounded — [OPEN · Architecture debt · S]

- **Summary:** `GitPullRequestService` keeps every `sessionId:repositoryId` PR file list for process lifetime, including expired entries and deleted Sessions.
- **Evidence:** `src/runtime/git/pull-request.ts:137-156,161-207` — `expiresAt` only skips reuse; nothing deletes stale keys. `src/runtime/bootstrap.ts:578-586` Session delete does not notify Git. Nearby Runtime caches document LRU eviction; this Map does not.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** Bound or evict the PR cache (TTL sweep, max entries, or drop keys on session/project delete). Acceptance: a unit test fills more than the bound or deletes the Session and asserts cache size; no claim of a native leak required.

### AD-test-hyphenated-sibling-discovery — [OPEN · Coverage or observability gap · S]

- **Summary:** The documented default `check --test` command discovers only exact-stem tests, so hyphenated sibling suites such as `project-status-runner.test.ts` never run for the files they cover.
- **Evidence:** `.agents/skills/quality-check/scripts/check.ts:141-176` generates stem candidates only. `src/runtime/__tests__/project-status-runner.test.ts` is the `runProjectStatusCommand` suite and is not a `project-status` stem. Excluding `runtime.integration.test.ts` from `src/runtime/*.ts` is an intentional tradeoff (`IT-runtime-integration-not-inferred`), not part of this entry.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** Include same-directory hyphenated sibling tests in stem discovery. Do not map `bootstrap.ts` onto `runtime.integration.test.ts`. Acceptance: `check.test.ts` asserts `project-status.ts` candidates include `project-status-runner.test.ts`.

### AD-ui-work-tab-tablist — [OPEN · Coverage or observability gap · M]

- **Summary:** Open-work navigation claims `tablist`/`tab` but does not implement the ChromeTabs keyboard, roving-tabindex, or tabpanel contract; process status is a color-only dot.
- **Evidence:** `src/renderer/src/features/tabs/WorkTabStrip.tsx:226-232` and `WorkTab.tsx:109-114,133-147` expose tab roles without arrows, `aria-controls`, or an aria twin for the process dot. `src/renderer/src/components/ChromeTabs.tsx:91-135,176-193` implements automatic activation for Inspector/Settings. `e2e/chrome-tabs.e2e.ts` covers those chrome tabs only. `DESIGN.md:224-225` requires keyboard reachability (already met via Tab) and a text/aria twin for color status.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-13 @ 940d949
- **Remediation target / Acceptance:** Teach `WorkTabStrip` the ChromeTabs keyboard/association contract or stop claiming `tablist`/`tab`; give process/dirty status a text or aria twin. Acceptance: focused work tablist changes the active Terminal or file with arrows, or the role is no longer `tablist`; color-only process dots fail a focused a11y assertion.

---

## RESOLVED

### AD-persist-non-atomic-document-save — [RESOLVED · Confirmed defect · M]

- **Summary:** Editor save truncates then overwrites in place with no atomic rename or mutation journal, so a crash mid-save can permanently empty or truncate the user's file.
- **Evidence:** `src/runtime/files/documents.ts:122-203` writes and syncs a same-directory `O_NOFOLLOW` replacement, revalidates its identity and containment, atomically renames it, syncs the directory, and cleans up only the trusted inode. `src/runtime/files/__tests__/documents.test.ts:53-203` covers complete replacement, interrupted writes, swapped parents, and safe cleanup.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ 85cbbd1 via #75 (initial implementation 99f533a; containment hardening d3e4540 and 85cbbd1).
- **Remediation target / Acceptance:** Atomic replace for `files.write` (same-dir temp write + fsync + rename) or journaled save. Acceptance: kill Runtime mid-save never leaves a permanently empty file that previously had content; user gets old full bytes or new full bytes. Regression covers crash-between-truncate-and-write.

### AD-sec-config-disk-size-cap — [RESOLVED · Architecture debt · S]

- **Summary:** Settings/keybindings/theme disk load and hot-reload read and parse without a pre-parse size cap, while IPC update and theme import already bound sources—so an oversized userData config can inflate Runtime memory and cross-process event/get payloads.
- **Evidence:** `src/shared/configuration-contract.ts:4-21` owns the 256 KiB UTF-8 source and 1,024-keybinding limits. `src/runtime/configuration.ts:136-170` performs bounded reads before parsing; `src/shared/ipc/methods.ts:79-85`, `src/shared/ipc/events.ts:15`, and `src/shared/ipc/domain.ts:629-630` reuse the same schemas. `src/runtime/__tests__/configuration.test.ts:276-440` and `src/shared/ipc/__tests__/contracts.test.ts:204-231` cover startup, hot reload, and IPC rejection.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ 40d6d13 via #76.
- **Remediation target / Acceptance:** Shared max for settings/keybindings/theme sources enforced on disk load, hot-reload, and IPC; bound event/result `source` (and keybindings array growth) to the same ceiling. Acceptance: oversized userData config keeps prior valid state, does not emit/get multi-cap sources; focused unit test fails if the size gate is removed.

### AD-state-dual-editor-dirty — [RESOLVED · Architecture debt · M]

- **Summary:** Editor dirtiness is dual-written to Renderer document cache and durable `openTabs[].dirty` without content, so after crash/relaunch a tab can stay durable-dirty while content is clean disk and preview rules still treat it as dirty.
- **Evidence:** `src/shared/editor-state.ts:34-51` normalizes durable tabs clean and rehydrates transient dirtiness only from live documents. `src/runtime/db/models/sessions.ts:149-151` removes legacy/persisted dirty flags, while `src/renderer/src/stores/workbench.ts:63-64,206` reconciles live cache state but persists clean metadata. Regression coverage lives at `src/runtime/db/__tests__/db.integration.test.ts:413-458`, `src/renderer/src/stores/workbench.test.ts:148-218`, and `src/renderer/src/features/editor/document-actions.test.ts:105-184`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ d2b3502 via #77.
- **Remediation target / Acceptance:** Single dirty source of truth, or clear durable `openTabs.dirty` on bootstrap/open when no recoverable draft content exists. Acceptance: no path leaves `openTabs.dirty=true` without live dirty content or a recoverable draft; UI dots and preview rules agree.

### AD-domain-runtime-index-boundary — [RESOLVED · Architecture debt · M]

- **Summary:** Nested Runtime domains `files/` and `agents/` lack `index.ts` public surfaces while production and cross-domain code deep-import internals, so Agents cannot predict import boundaries.
- **Evidence:** `src/runtime/agents/index.ts` and `src/runtime/files/index.ts` expose the public surfaces; current production consumers import their domain roots. `src/runtime/__tests__/structure.test.ts:54-92` independently requires barrels for domains with at least three modules and rejects cross-domain deep imports.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ 310f068 via #78.
- **Remediation target / Acceptance:** Domain `index.ts` barrels for files and agents; production imports only through those surfaces; Terminal launch resolve via public Agents (or executables) export. Acceptance: production Runtime imports of nested domains resolve only through each domain's `index.ts`.

### AD-ext-agent-display-single-source — [RESOLVED · Architecture debt · S]

- **Summary:** Adding a hosted Agent provider is not one catalog+adapter path: default Terminal titles and hosted icon labels re-declare display strings outside `agentProviderCatalog`.
- **Evidence:** `src/runtime/session-policy.ts:24-25` and `src/renderer/src/icons/agents/agent-icon-registry.ts:26-28` derive managed-provider titles and labels from `src/shared/agents.ts:46-56`. Exhaustive catalog coverage lives at `src/runtime/__tests__/session-policy.test.ts:57-66` and `src/renderer/src/icons/agents/agent-icon-registry.test.ts:8-21`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ 58ebede via #79.
- **Remediation target / Acceptance:** Derive default agent Terminal titles (shell remains local) and hosted icon labels from the catalog, or add bi-directional exhaustiveness tests. Acceptance: catalog id + providers registry is enough for default title and displayName consumers; extra icon assets stay the only optional UI step.

### AD-test-runtime-scale-rule-gate — [RESOLVED · Coverage or observability gap · S]

- **Summary:** The Runtime domain scale / `index.ts` boundary is documented but has no test, lint, or knip gate, so boundary drift stays green under typecheck.
- **Evidence:** `src/runtime/__tests__/structure.test.ts:54-92` scans direct Runtime domains, requires `index.ts` at the scale threshold, parses production imports, and rejects cross-domain paths below a domain root. The focused structure test still passes on `main@940d949`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ 310f068 via #78.
- **Remediation target / Acceptance:** Cheap structure test or eslint/knip boundary rule requiring nested-domain `index.ts` and forbidding production deep cross-domain imports. Acceptance: introducing missing domain `index.ts` or illegal deep imports fails a focused automated check.

### AD-persist-schema-version-hand-sync — [RESOLVED · Architecture debt · M]

- **Summary:** Schema evolution requires hand-keeping Drizzle SQL `?raw` imports, `preservingMigrations`, `CURRENT_SCHEMA_VERSION`, and `app_state.schemaVersion` in sync (drizzle journal meta numbering also diverges), so a missed edit can split fresh vs upgraded DBs.
- **Evidence:** `src/runtime/db/migrations/manifest.ts:20-85` validates the bundled SQL list against Drizzle's journal and derives preservation/current versions. `src/runtime/db/index.ts:49` owns the matching `app_state.schemaVersion` write. `src/runtime/db/__tests__/migration-manifest.test.ts:13-41` rejects missing, reordered, or duplicate entries; `src/runtime/db/__tests__/db.integration.test.ts:32-33,208-284` covers fresh, floor, and N-1 upgrades.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ 8301a1a via #81.
- **Remediation target / Acceptance:** Derive version and preserving list from migrations meta/journal; one writer for `user_version` and app-state; CI equality gate. Acceptance: new drizzle migration cannot ship without version advancement; upgrade-from-floor coverage remains.

### AD-ui-design-redline-drift — [RESOLVED · Contract drift · M]

- **Summary:** Authoritative DESIGN type/spacing/radius redlines are already violated in chrome primitives and are not lint-enforced, so interaction density drifts by ad-hoc Tailwind literals.
- **Evidence:** `DESIGN.md:25-78` now defines dense type, optical spacing, control-height, radius, platform exceptions, and the closed arbitrary-value policy. `src/runtime/__tests__/renderer-design-contract.test.ts:10-142` recognizes typography, control-height, positive/negative spacing, and radius classes before enforcing the explicit allowlist; it still passes on `main@940d949`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ 1e77c5c via #82.
- **Remediation target / Acceptance:** Normalize chrome to meta/base and the 4px grid, or revise DESIGN to admit the dense set; optional ESLint/Tailwind ban for off-contract classes. Acceptance: no Renderer class uses banned sizes/spacings/radii without an explicit DESIGN exception.

### AD-ui-dual-theme-css-bootstrap — [RESOLVED · Architecture debt · S]

- **Summary:** Main workbench and Process Explorer each own a full Tailwind `@theme` bootstrap, so semantic token additions must be dual-edited and already diverge.
- **Evidence:** `src/renderer/src/styles/theme.css:9-75` is the only semantic Tailwind/default-theme bootstrap. Both `src/renderer/src/styles/styles.css:1` and `src/renderer/src/styles/process-explorer.css:1` import it. `src/runtime/__tests__/renderer-theme-contract.test.ts:29-52` rejects another `@theme` source or an entry that stops importing the shared file.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ fba7662 via #83.
- **Remediation target / Acceptance:** Extract shared theme-bootstrap CSS (unregister + `@theme` + defaults); keep PE-only rules separate. Acceptance: adding a semantic token is a single edit consumed by both entries.

### AD-ui-input-primitive-bypass — [RESOLVED · Architecture debt · M]

- **Summary:** Shared Input encodes the field redline, but dense workbench surfaces reimplement raw `<input>` with different heights and focus treatment, fragmenting interaction chrome.
- **Evidence:** `src/renderer/src/components/ui/input.tsx:6-69` owns `standard`, `dense`, `compact`, and `palette` sizes plus shared appearances and `InputGroup`. FileTree, Project Search, Commit History, Project/Session rename, and Path Browser now consume those variants. `src/runtime/__tests__/renderer-design-contract.test.ts:85-121` rejects feature-local raw text inputs.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ 1e77c5c via #82.
- **Remediation target / Acceptance:** Dense size (and optional adornment) variants on Input; migrate inspector/search/rename fields. Acceptance: feature-local text fields do not reinvent border/focus/radius; density is a prop on the shared primitive.

### AD-toolchain-shadcn-components-json — [RESOLVED · Contract drift · S]

- **Summary:** `components.json` still declares `baseColor: zinc` and a single CSS path, conflicting with the unregistered-default-palette guarantee and dual renderer CSS entries.
- **Evidence:** `components.json:8-9` now points shadcn at the shared `src/renderer/src/styles/theme.css`; `DESIGN.md:25-29` documents why immutable `baseColor: zinc` metadata does not re-enable the unregistered default palette. `src/runtime/__tests__/renderer-theme-contract.test.ts:55-67` locks both properties to the intentional contract.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ fba7662 via #83.
- **Remediation target / Acceptance:** Align `components.json` with semantic tokens and shared theme CSS; document PE dual-entry handling. Acceptance: project-guided shadcn add does not reintroduce palette utilities or leave PE bootstrap stale.

### AD-lifecycle-pe-render-recovery — [RESOLVED · Coverage or observability gap · S]

- **Summary:** Process Explorer has no React ErrorBoundary and no Main `render-process-gone` crash-policy, so a PE render throw or renderer crash blanks the diagnostic window without workbench-style recovery.
- **Evidence:** `src/renderer/src/process-explorer-main.tsx:6-18` wraps the diagnostic app in the shared recoverable `ErrorBoundary`. `src/main/process-explorer-window.ts:97-124` applies bounded crash-policy reloads and stops a crash loop cleanly. `src/main/__tests__/crash-policy.test.ts:5-44` covers the backoff budget; `e2e/process-explorer-recovery.e2e.ts:93-151` covers render reload and repeated renderer crashes on real Electron.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 940d949
- **Resolved:** 2026-08-11 @ bd4f813 via #84.
- **Remediation target / Acceptance:** Reuse ErrorBoundary (or PE fallback) on the PE entry; optionally register Main crash recovery for the PE window. Acceptance: forced PE render throw shows recovery UI; process-gone does not leave an unrecovered blank PE indefinitely.

---

## Intentional tradeoffs (not debt — do not "fix" without product change)

Recorded so repeat audits do not reclassify them as findings.

| ID                                   | Tradeoff                                                                                                        | Evidence                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| IT-disk-wins-dirty-buffer            | External disk changes replace dirty editor buffers without a conflict dialog                                    | architecture / `external-sync`                                   |
| IT-unsaved-buffers-not-durable       | Document bodies stay Renderer-local; SQLite holds tab metadata only                                             | `session_state` / session-view                                   |
| IT-dual-terminal-snapshot-pipelines  | Live PTY keeps raw durable snapshot (encoding 1) and headless screen for reattach (encoding 2); bounded         | `src/runtime/terminal/screen.ts`, TerminalManager attach/persist |
| IT-copy-not-journaled                | `files.copy` is best-effort, may leave partial trees, Main wait non-expiring; create/rename/move are journaled  | `supervisor.ts`, `mutation-journal`, partial-copy tests          |
| IT-project-status-fixed-allowlist    | Project Status CLIs fixed to gh / linear / vc; not a plugin adapter surface                                     | architecture, `project-status.ts`                                |
| IT-pe-flag-redaction-only            | Process Explorer redacts common credential **flag** argv shapes only (best-effort); not full `redactSecretText` | `process-explorer.ts` `redactProcessName`                        |
| IT-npm-packageManager-bun-day-to-day | packageManager npm for electron-builder native rebuilds; day-to-day `ni` + `bun run`                            | `package.json`, AGENTS.md                                        |
| IT-typescript-6-eslint-plus-7-tsc    | typescript package aliases TS6 for eslint; `@typescript/native` supplies TS7 tsc                                | electron-toolchain / stack-baseline                              |
| IT-electron-vite-beta                | electron-vite 6 beta accepted for Vite 8 + utilityProcess                                                       | package.json, electron-toolchain.md                              |
| IT-runtime-integration-not-inferred  | `check` does not map every `src/runtime/*.ts` edit onto `runtime.integration.test.ts`                           | `check.ts`, `check.test.ts`                                      |
| IT-window-level-error-boundary       | Render exceptions recover via a window-level ErrorBoundary plus reload, not nested feature boundaries           | `ErrorBoundary.tsx`, both Renderer entries                       |
| IT-eslint-renderer-import-gate       | Renderer Node/Electron isolation is ESLint `no-restricted-imports` plus sandbox, not a bundle AST walk          | `eslint.config.ts`, `BrowserWindow` webPreferences               |

---

## Current priority guide (OPEN at 2026-08-13)

**Top priorities:** `AD-lifecycle-mutation-remap-origin-delete` → `AD-sec-packaged-renderer-url` → `AD-sec-hook-config-size-cap` → `AD-state-sibling-session-invalidation` → `AD-ui-inspector-show-reveal`.

**Quick wins (S):** packaged renderer URL · hook-config size cap · Inspector show reveal · E2E provider shims · public `git.diff` · PR cache bound · hyphenated sibling discovery.

## Historical priority guide (all resolved)

Retained to explain the original execution order used by PR #101.

**Top priorities:** `AD-persist-non-atomic-document-save` → `AD-sec-config-disk-size-cap` → `AD-state-dual-editor-dirty` → `AD-domain-runtime-index-boundary` + `AD-test-runtime-scale-rule-gate` → `AD-ext-agent-display-single-source`.

**Quick wins (S):** scale-rule gate · agent display single-source · shared theme CSS · `components.json` · PE ErrorBoundary · config disk size cap + tests.

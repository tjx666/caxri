# Architecture debt ledger

Persistent record of architecture-debt audit findings for revalidation across runs.
Maintained per `.agents/skills/audit-architecture-debt/references/debt-ledger.md`.

| Field            | Value                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| **First audit**  | 2026-08-11 @ `eb9becbee1f9c77d914fa6d113fa6084dba587b5` (`main`)                        |
| **Last updated** | 2026-08-11 @ `eb2ba40`                                                                  |
| **Scope**        | Repository-wide tracked implementation (read-only discovery + independent verification) |

Statuses: `OPEN` · `RESOLVED` · `STALE`. Effort: S / M / L per the audit report format.
Category labels match the audit skill: Confirmed defect, Architecture debt, Contract drift,
Coverage or observability gap, Modernization opportunity, Intentional tradeoff.

---

## OPEN

### AD-persist-non-atomic-document-save — [OPEN · Confirmed defect · M]

- **Summary:** Editor save truncates then overwrites in place with no atomic rename or mutation journal, so a crash mid-save can permanently empty or truncate the user's file.
- **Evidence:** `src/runtime/files/documents.ts` (`truncate(0)` then `writeFile`); `src/runtime/files/service.ts` (`files.write` outside `mutationJournal.run`); `src/main/supervisor.ts` (`files.write` in `NON_EXPIRING_RUNTIME_METHODS` because there is no durable completion journal). Contrast: `src/runtime/configuration.ts` `atomicWrite` (tmp + fsync + rename).
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Atomic replace for `files.write` (same-dir temp write + fsync + rename) or journaled save. Acceptance: kill Runtime mid-save never leaves a permanently empty file that previously had content; user gets old full bytes or new full bytes. Regression covers crash-between-truncate-and-write.

### AD-sec-config-disk-size-cap — [OPEN · Architecture debt · S]

- **Summary:** Settings/keybindings/theme disk load and hot-reload read and parse without a pre-parse size cap, while IPC update and theme import already bound sources—so an oversized userData config can inflate Runtime memory and cross-process event/get payloads.
- **Evidence:** `src/runtime/configuration.ts` (`loadOrCreate` / `onExternalChange` `readFile` + prepare with no size gate); `src/shared/ipc/methods.ts` (`configurationSource` max 128 KiB; theme update 256 KiB); `src/runtime/theme.ts` (`MAX_THEME_IMPORT_FILE_BYTES` before import read); `src/shared/ipc/events.ts` and get results use unbounded `source: z.string()`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Shared max for settings/keybindings/theme sources enforced on disk load, hot-reload, and IPC; bound event/result `source` (and keybindings array growth) to the same ceiling. Acceptance: oversized userData config keeps prior valid state, does not emit/get multi-cap sources; focused unit test fails if the size gate is removed.

### AD-state-dual-editor-dirty — [OPEN · Architecture debt · M]

- **Summary:** Editor dirtiness is dual-written to Renderer document cache and durable `openTabs[].dirty` without content, so after crash/relaunch a tab can stay durable-dirty while content is clean disk and preview rules still treat it as dirty.
- **Evidence:** `src/renderer/src/features/editor/document-actions.ts` (dual write on change; `openFile` caches `dirty:false`); `src/shared/editor-state.ts` (`openEditorTabState` keeps existing openTabs dirty; preview replacement uses `!tab.dirty`); `src/renderer/src/features/tabs/WorkTabStrip.tsx` (UI dots read cache only); `src/runtime/db` session state stores `openTabsJson` without document bodies.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Single dirty source of truth, or clear durable `openTabs.dirty` on bootstrap/open when no recoverable draft content exists. Acceptance: no path leaves `openTabs.dirty=true` without live dirty content or a recoverable draft; UI dots and preview rules agree.

### AD-domain-runtime-index-boundary — [OPEN · Architecture debt · M]

- **Summary:** Nested Runtime domains `files/` and `agents/` lack `index.ts` public surfaces while production and cross-domain code deep-import internals, so Agents cannot predict import boundaries.
- **Evidence:** No `src/runtime/files/index.ts` or `src/runtime/agents/index.ts`; `src/runtime/bootstrap.ts` imports `./agents/coordinator`, `./agents/service`, `./files/service`; `src/runtime/terminal/index.ts` imports `../agents/discovery`. Contrast: `src/runtime/git/index.ts` and `src/runtime/terminal/index.ts` barrels. Contract: `AGENTS.md` / architecture Runtime scale rule (≥3 modules → domain folder + `index.ts`).
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Domain `index.ts` barrels for files and agents; production imports only through those surfaces; Terminal launch resolve via public Agents (or executables) export. Acceptance: production Runtime imports of nested domains resolve only through each domain's `index.ts`.

### AD-ext-agent-display-single-source — [OPEN · Architecture debt · S]

- **Summary:** Adding a hosted Agent provider is not one catalog+adapter path: default Terminal titles and hosted icon labels re-declare display strings outside `agentProviderCatalog`.
- **Evidence:** `src/shared/agents.ts` (catalog `displayName`); `src/runtime/session-policy.ts` (`DEFAULT_TERMINAL_TITLE` hard-codes Claude Code/Codex); `src/renderer/src/icons/agents/agent-icon-registry.ts` (parallel labels). Some UI already uses `agentProviderCatalog[provider].displayName`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Derive default agent Terminal titles (shell remains local) and hosted icon labels from the catalog, or add bi-directional exhaustiveness tests. Acceptance: catalog id + providers registry is enough for default title and displayName consumers; extra icon assets stay the only optional UI step.

### AD-test-runtime-scale-rule-gate — [OPEN · Coverage or observability gap · S]

- **Summary:** The Runtime domain scale / `index.ts` boundary is documented but has no test, lint, or knip gate, so boundary drift stays green under typecheck.
- **Evidence:** `AGENTS.md` scale rule only; `eslint.config.ts` has max-lines and Renderer Node bans, not Runtime domain barrels; live counterexample `terminal` → `agents/discovery` deep import. Contrast: IPC contracts and command catalogs have exhaustiveness tests.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Cheap structure test or eslint/knip boundary rule requiring nested-domain `index.ts` and forbidding production deep cross-domain imports. Acceptance: introducing missing domain `index.ts` or illegal deep imports fails a focused automated check.

### AD-persist-schema-version-hand-sync — [OPEN · Architecture debt · M]

- **Summary:** Schema evolution requires hand-keeping Drizzle SQL `?raw` imports, `preservingMigrations`, `CURRENT_SCHEMA_VERSION`, and `app_state.schemaVersion` in sync (drizzle journal meta numbering also diverges), so a missed edit can split fresh vs upgraded DBs.
- **Evidence:** `src/runtime/db/connection.ts` (`CURRENT_SCHEMA_VERSION = 11`, hand-listed SQL 0000–0005, `preservingMigrations` 8–11); `src/runtime/bootstrap.ts` writes `schemaVersion` app-state; `src/runtime/db/migrations/meta/_journal.json` independent numbering. Integration tests assert the constant, not multi-artifact equality.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Derive version and preserving list from migrations meta/journal; one writer for `user_version` and app-state; CI equality gate. Acceptance: new drizzle migration cannot ship without version advancement; upgrade-from-floor coverage remains.

### AD-ui-design-redline-drift — [OPEN · Contract drift · M]

- **Summary:** Authoritative DESIGN type/spacing/radius redlines are already violated in chrome primitives and are not lint-enforced, so interaction density drifts by ad-hoc Tailwind literals.
- **Evidence:** `DESIGN.md` (type 15/13/11/10; gaps 4/8/12/16/24; radius 4/6/8); `src/renderer/src/features/status-bar/StatusBar.tsx` (`gap-[5px]`, `rounded-[3px]`, `px-[5px]`); `src/renderer/src/components/ui/tooltip.tsx` and `context-menu.tsx` (`text-[12px]`); path-browser 12px chrome. ESLint has no design-scale gate.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Normalize chrome to meta/base and the 4px grid, or revise DESIGN to admit the dense set; optional ESLint/Tailwind ban for off-contract classes. Acceptance: no Renderer class uses banned sizes/spacings/radii without an explicit DESIGN exception.

### AD-ui-dual-theme-css-bootstrap — [OPEN · Architecture debt · S]

- **Summary:** Main workbench and Process Explorer each own a full Tailwind `@theme` bootstrap, so semantic token additions must be dual-edited and already diverge.
- **Evidence:** `src/renderer/src/main.tsx` → `styles/styles.css`; `src/renderer/src/process-explorer-main.tsx` → `styles/process-explorer.css`; PE `@theme` is a subset (missing accent/success/overlay/shadow/indicator utilities). No shared theme partial under `src/renderer/src/styles/`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Extract shared theme-bootstrap CSS (unregister + `@theme` + defaults); keep PE-only rules separate. Acceptance: adding a semantic token is a single edit consumed by both entries.

### AD-ui-input-primitive-bypass — [OPEN · Architecture debt · M]

- **Summary:** Shared Input encodes the field redline, but dense workbench surfaces reimplement raw `<input>` with different heights and focus treatment, fragmenting interaction chrome.
- **Evidence:** `src/renderer/src/components/ui/input.tsx` (h-9, accent focus ring); Settings/Keybindings use it; raw inputs in FileTree rename, ProjectSearch, CommitHistory filter, ProjectGroup rename, PathBrowser. DESIGN lists dense list rows and 36px inputs but no dense Input variant.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Dense size (and optional adornment) variants on Input; migrate inspector/search/rename fields. Acceptance: feature-local text fields do not reinvent border/focus/radius; density is a prop on the shared primitive.

### AD-toolchain-shadcn-components-json — [OPEN · Contract drift · S]

- **Summary:** `components.json` still declares `baseColor: zinc` and a single CSS path, conflicting with the unregistered-default-palette guarantee and dual renderer CSS entries.
- **Evidence:** `components.json` (`css` → `styles.css` only, `baseColor: zinc`); `styles.css` / `process-explorer.css` both unregister `--color-*: initial`; DESIGN principle 5. Risk is generator drift, not live zinc classes today.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
- **Remediation target / Acceptance:** Align `components.json` with semantic tokens and shared theme CSS; document PE dual-entry handling. Acceptance: project-guided shadcn add does not reintroduce palette utilities or leave PE bootstrap stale.

### AD-lifecycle-pe-render-recovery — [OPEN · Coverage or observability gap · S]

- **Summary:** Process Explorer has no React ErrorBoundary and no Main `render-process-gone` crash-policy, so a PE render throw or renderer crash blanks the diagnostic window without workbench-style recovery.
- **Evidence:** `src/renderer/src/main.tsx` wraps App in ErrorBoundary; `src/renderer/src/process-explorer-main.tsx` mounts PE app only; `src/main/index.ts` installs crash-policy on the main window; `src/main/process-explorer-window.ts` does not. No written contract waives PE render recovery.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-11 @ eb9becb
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

---

## RESOLVED

_(None yet. Keep resolved entries permanently with resolving commit when fixed.)_

---

## Priority guide (from first audit)

**Top priorities:** `AD-persist-non-atomic-document-save` → `AD-sec-config-disk-size-cap` → `AD-state-dual-editor-dirty` → `AD-domain-runtime-index-boundary` + `AD-test-runtime-scale-rule-gate` → `AD-ext-agent-display-single-source`.

**Quick wins (S):** scale-rule gate · agent display single-source · shared theme CSS · `components.json` · PE ErrorBoundary · config disk size cap + tests.

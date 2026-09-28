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
| **Last full audit**      | 2026-08-16 @ `19474c0` (`main`)                                                                        |
| **Targeted review base** | 2026-08-24 @ `87b613a` ([issue caxri#165](https://github.com/tjx666/caxri/issues/165))                 |
| **Full-audit scope**     | Repository-wide revalidation of every prior OPEN entry plus Server, protocol, CLI, and Agent deltas    |
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

No OPEN entries as of 2026-08-16 @ `19474c0`.

### Incremental audit coverage

- Server authentication and lease replacement: capability fencing remains sound; the formerly tracked stale-socket lifecycle gap is resolved below.
- Protocol: the `agent`, `configuration`, `desktop`, `domain`, `registry`, and `transport` boundaries remain complete from the package root.
- CLI: production dependencies remain limited to `@caxri/agent-skills`, `@caxri/client`,
  `@caxri/protocol`, and `zod`, with package imports through reviewed public exports.
- Agent Endpoint and Peer Inbox: endpoint generation and duplicate-window cleanup are resolved below; inbox bytes, messages, waiters, receipts, pair traffic, expiry, and close cleanup remain bounded.
- A path-only CI parser was not added: ledger evidence includes symbols and shorthand whose semantic validity cannot be established by file existence alone. The maintenance cadence above requires semantic revalidation.

---

## RESOLVED

### AD-lifecycle-agent-endpoint-generation-map — [RESOLVED · Architecture debt · S]

- **Summary:** `AgentEndpointRegistry` no longer retains a generation counter for permanently deleted Terminals; restart retirement still preserves the monotonic generation for a live Terminal.
- **Evidence:** `apps/server/src/core/agent-endpoints/registry.ts:281` deletes the generation entry on permanent retirement, and the `forgetGenerationsWhere` pass at `apps/server/src/core/agent-endpoints/registry.ts:176-178` reclaims matching entries when a Session or Project is forgotten.
- **First seen:** 2026-08-15 @ 43af4d6 · **Last verified:** 2026-08-16 @ 19474c0
- **Resolved:** 2026-08-16 @ 19474c0 via [PR caxri#187](https://github.com/tjx666/caxri/pull/187).
- **Remediation target / Acceptance:** Permanent Terminal/Session/Project deletion reclaims generation state while a live Terminal restart keeps its monotonic generation. Tracked by [issue caxri#172](https://github.com/tjx666/caxri/issues/172).

### AD-lifecycle-stale-desktop-sockets — [RESOLVED · Confirmed defect · S]

- **Summary:** Replacing the authenticated Desktop now actively disconnects the previous socket after rejecting its pending commands and revoking its lease, so repeated replacements keep socket and client accounting bounded.
- **Evidence:** `apps/server/src/core/control-server.ts:469-476` revokes the replaced Desktop's authority and destroys its socket during lease replacement.
- **First seen:** 2026-08-15 @ 43af4d6 · **Last verified:** 2026-08-16 @ 19474c0
- **Resolved:** 2026-08-16 @ 19474c0 via [PR caxri#187](https://github.com/tjx666/caxri/pull/187).
- **Remediation target / Acceptance:** After rejecting pending commands and revoking authority, a replaced Desktop is actively disconnected while the new Desktop retains exclusive authority. Tracked by [issue caxri#173](https://github.com/tjx666/caxri/issues/173).

### AD-perf-agent-inbox-duplicate-window — [RESOLVED · Architecture debt · S]

- **Summary:** Peer Inbox duplicate fingerprints are now bounded by a fixed capacity in addition to the 30-second TTL, so distinct invalid targets can no longer grow duplicate state without limit.
- **Evidence:** `apps/server/src/core/agent-inbox/registry.ts:373-376` evicts the oldest duplicate records at `MAX_DUPLICATES` capacity while the TTL sweep continues to prune expired entries.
- **First seen:** 2026-08-15 @ 43af4d6 · **Last verified:** 2026-08-16 @ 19474c0
- **Resolved:** 2026-08-16 @ 19474c0 via [PR caxri#187](https://github.com/tjx666/caxri/pull/187).
- **Remediation target / Acceptance:** A fixed duplicate-window capacity preserves in-window retry behavior without changing authorization or delivery semantics. Tracked by [issue caxri#174](https://github.com/tjx666/caxri/issues/174).

### AD-lifecycle-mutation-remap-origin-delete — [RESOLVED · Confirmed defect · M]

- **Summary:** Deleting the Session that started a completed rename/move no longer lets the durable journal disappear before sibling same-Project state is remapped.
- **Evidence:** `apps/desktop/src/renderer/src/features/view-containers/resource-explorer/file-operation-reconciliation.ts` resolves the operation by `workbenchProjectId`, durably remaps every surviving same-Project Session, and acknowledges through the controlled extension provider only after apply succeeds. `apps/desktop/src/renderer/src/stores/selectors.ts` discovers those Sessions by Project identity.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-14 @ 2b8da83.
- **Remediation target / Acceptance:** A and B open the same file; move it from A; delete A before ack; B's tab, dirty buffer, and later reload show the new path; the operation is not acked while B still needs the remap.

### AD-sec-packaged-renderer-url — [RESOLVED · Architecture debt · S]

- **Summary:** Packaged workbench and Process Explorer windows cannot load an environment-supplied Renderer origin.
- **Evidence:** `apps/desktop/src/main/renderer-entry.ts:20-34` honors `ELECTRON_RENDERER_URL` only when unpackaged and otherwise resolves an application-bundle file URL. `apps/desktop/src/main/__tests__/renderer-entry.test.ts:9-77` covers both windows and both modes.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ 3903e7e via [issue caxri#166](https://github.com/tjx666/caxri/issues/166).
- **Remediation target / Acceptance:** Packaged mode ignores `ELECTRON_RENDERER_URL`; unpackaged development mode retains it.

### AD-sec-hook-config-size-cap — [RESOLVED · Architecture debt · S]

- **Summary:** Provider-owned Agent lifecycle-hook configuration is bounded before any adapter receives or parses it.
- **Evidence:** `apps/server/src/domains/agents/hooks/manager.ts:175-184` reads provider targets through the shared bounded regular-file reader with a 1 MiB limit. `apps/server/src/domains/agents/hooks/__tests__/manager.integration.test.ts:440-486` proves an oversized file is neither parsed nor rewritten.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ e1c5948
- **Resolved:** 2026-08-15 @ b6fe27c and bdd1806 via [issue caxri#167](https://github.com/tjx666/caxri/issues/167).
- **Remediation target / Acceptance:** Oversized provider configuration fails closed without parsing or rewriting the file; supported bounded files continue to reconcile.

### AD-sec-theme-import-bounded-read — [RESOLVED · Confirmed defect · S]

- **Summary:** Theme import now reads through one regular-file handle into a fixed-size buffer and rejects growth before format sniffing or parsing, while preserving final-symlink compatibility for user-owned theme and provider configuration files.
- **Evidence:** `apps/server/src/domains/bounded-file-reader.ts:15-50` reads at most `maxBytes + 1` through one handle and rejects non-regular or overflowing sources. `apps/server/src/domains/theme.ts:312-328` uses that boundary; `apps/server/src/domains/__tests__/theme.test.ts:95-180` covers final symlinks, post-open growth, and FIFO rejection.
- **First seen:** 2026-08-13 @ 63a7ccc · **Last verified:** 2026-08-15 @ e1c5948
- **Resolved:** 2026-08-15 @ b6fe27c and bdd1806 via [issue caxri#167](https://github.com/tjx666/caxri/issues/167).
- **Remediation target / Acceptance:** No parser receives more than 1 MiB; post-open growth returns `CAPACITY`, pathname replacement cannot redirect the opened handle, and normal supported imports continue to succeed.

### AD-state-sibling-session-invalidation — [RESOLVED · Confirmed defect · M]

- **Summary:** Project-shared filesystem and Git facts now invalidate every same-Project Session, including a sibling selected during a queued watcher batch.
- **Evidence:** Server Core emits scope-bound `files.changed` events; `apps/desktop/src/renderer/src/queries/invalidation.ts` invalidates Core Resource Explorer reads for every same-Project Session without an Extension Host echo. `apps/server/src/domains/files/__tests__/watcher.scope.integration.test.ts` covers queued rebind and cross-Project fencing.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ 660ef29 via [issue caxri#168](https://github.com/tjx666/caxri/issues/168).
- **Remediation target / Acceptance:** Two Sessions sharing one Project observe matching `files.list` and `git.summary` after an external write and immediate Session switch; another Project remains untouched.

### AD-ui-secondarySidebar-show-reveal — [RESOLVED · Contract drift · S]

- **Summary:** Catalogued SecondarySidebar Show commands and Search Files now reveal a hidden SecondarySidebar before selecting their target mode.
- **Evidence:** `apps/desktop/src/renderer/src/commands/execute.ts:49-57` owns the reveal-and-activate boundary; command registrations use it at `apps/desktop/src/renderer/src/commands/execute.ts:135-147`. `apps/desktop/src/renderer/src/commands/execute.test.ts` covers all registered Show commands and Search Files.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ b6826f5 via [issue caxri#169](https://github.com/tjx666/caxri/issues/169).
- **Remediation target / Acceptance:** With the SecondarySidebar hidden, each Show command and its default binding makes the requested panel visible without rewriting an already-visible layout.

### AD-ext-e2e-provider-shims — [RESOLVED · Architecture debt · S]

- **Summary:** Caxri-owned E2E executable environment keys and blocked Shell shims derive from the managed Agent provider catalog.
- **Evidence:** `packages/system/src/testing/agent-policy.ts:36-41` derives provider environment keys, and `packages/system/src/testing/agent-policy.ts:96-105` builds every provider shim from `agentProviderIds`. `packages/system/src/testing/__tests__/agent-policy.test.ts` locks catalog coverage.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-14 @ 75ed0f4 as part of [PR caxri#138](https://github.com/tjx666/caxri/pull/138).
- **Remediation target / Acceptance:** Adding a managed provider automatically yields its fake-executable environment key and blocked shim, with an exhaustive focused test.

### AD-ext-public-git-diff — [RESOLVED · Architecture debt · S]

- **Summary:** The obsolete raw-string `git.diff` operation is no longer part of the public protocol or domain handler table.
- **Evidence:** `packages/protocol/src/registry/methods.ts:552-568` exposes only typed diff documents. `packages/protocol/src/__tests__/index.test.ts:227-253` proves Desktop negotiation omits `git.diff` and public request parsing rejects it.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ e7489de via [issue caxri#170](https://github.com/tjx666/caxri/issues/170).
- **Remediation target / Acceptance:** `git.diffDocument` and `git.pullRequestDiffDocument` remain the bounded public diff reads; `git.diff` cannot negotiate or parse.

### AD-perf-pr-cache-unbounded — [RESOLVED · Architecture debt · S]

- **Summary:** Pull Request metadata caching now has TTL pruning, a fixed LRU capacity, deletion eviction, and shutdown cleanup.
- **Evidence:** `apps/server/src/domains/git/pull-request.ts:161-188` implements Session eviction, clear, expiry pruning, and a 128-entry LRU. `apps/server/src/domains/create-domain-services.ts:535-548,628-633` evicts Project and Session keys. `apps/server/src/domains/git/__tests__/pull-request.test.ts:73-202` covers expiry, capacity, deletion, collision, and in-flight invalidation.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ 43af4d6
- **Resolved:** 2026-08-15 @ e7489de via [issue caxri#170](https://github.com/tjx666/caxri/issues/170).
- **Remediation target / Acceptance:** Historical Session/repository entries stay bounded, deleted Sessions cannot repopulate the cache, and unrelated identifiers cannot collide.

### AD-ui-work-tab-tablist — [RESOLVED · Confirmed defect · M]

- **Summary:** Open Work now implements automatic keyboard activation, roving focus, an actual active tabpanel association, and a text alternative for dirty state.
- **Evidence:** `apps/desktop/src/renderer/src/features/tabs/work-tab-strip.tsx:298-318` implements Arrow, Home, and End navigation. `apps/desktop/src/renderer/src/features/tabs/work-tab.tsx` owns tab semantics and the dirty-state description. `e2e/editor-tabs.e2e.ts` covers mixed Terminal/editor keyboard and accessibility behavior, including preserving roving focus after Terminal attachment.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified:** 2026-08-15 @ e1c5948
- **Resolved:** 2026-08-15 @ 43af4d6 via [issue caxri#171](https://github.com/tjx666/caxri/issues/171).
- **Remediation target / Acceptance:** Arrow/Home/End changes and focuses the active work target, one tab participates in sequential focus, the active surface is associated, and unsaved state has a screen-reader description.

### AD-persist-non-atomic-document-save — [RESOLVED · Confirmed defect · M]

- **Summary:** Editor save truncates then overwrites in place with no atomic rename or mutation journal, so a crash mid-save can permanently empty or truncate the user's file.
- **Evidence:** `apps/server/src/domains/files/documents.ts:122-203` writes and syncs a same-directory `O_NOFOLLOW` replacement, revalidates its identity and containment, atomically renames it, syncs the directory, and cleans up only the trusted inode. `apps/server/src/domains/files/__tests__/documents.test.ts:53-203` covers complete replacement, interrupted writes, swapped parents, and safe cleanup.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 85cbbd1 via [issue caxri#75](https://github.com/tjx666/caxri/issues/75) (initial implementation 99f533a; containment hardening d3e4540 and 85cbbd1).
- **Remediation target / Acceptance:** Atomic replace for `files.write` (same-dir temp write + fsync + rename) or journaled save. Acceptance: kill Server Core mid-save never leaves a permanently empty file that previously had content; user gets old full bytes or new full bytes. Regression covers crash-between-truncate-and-write.

### AD-sec-config-disk-size-cap — [RESOLVED · Architecture debt · S]

- **Summary:** Settings/keybindings/theme disk load and hot-reload read and parse without a pre-parse size cap, while IPC update and theme import already bound sources—so an oversized userData config can inflate Server memory and cross-process event/get payloads.
- **Evidence:** `packages/protocol/src/configuration/configuration-contract.ts` owns the bounded source and keybinding limits. `apps/server/src/domains/config.ts` performs bounded reads before parsing; protocol registry and event schemas reuse the same contracts. `apps/server/src/domains/__tests__/configuration.test.ts` and `packages/protocol/src/__tests__/contracts.test.ts` cover startup, hot reload, and protocol rejection.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 40d6d13 via [issue caxri#76](https://github.com/tjx666/caxri/issues/76).
- **Remediation target / Acceptance:** Shared max for settings/keybindings/theme sources enforced on disk load, hot-reload, and IPC; bound event/result `source` (and keybindings array growth) to the same ceiling. Acceptance: oversized userData config keeps prior valid state, does not emit/get multi-cap sources; focused unit test fails if the size gate is removed.

### AD-state-dual-editor-dirty — [RESOLVED · Architecture debt · M]

- **Summary:** Editor dirtiness is dual-written to Renderer document cache and durable `openTabs[].dirty` without content, so after crash/relaunch a tab can stay durable-dirty while content is clean disk and preview rules still treat it as dirty.
- **Evidence:** `apps/desktop/src/shared/editor-state.ts:34-51` normalizes durable tabs clean and rehydrates transient dirtiness only from live documents. `apps/server/src/domains/db/models/sessions.ts:149-151` removes legacy/persisted dirty flags, while `apps/desktop/src/renderer/src/stores/workbench.ts:63-64,206` reconciles live cache state but persists clean metadata. Regression coverage lives at `apps/server/src/domains/db/__tests__/database.integration.test.ts`, `apps/desktop/src/renderer/src/stores/workbench.test.ts:148-218`, and `apps/desktop/src/renderer/src/features/editor/document-commands.test.ts:105-184`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ d2b3502 via [issue caxri#77](https://github.com/tjx666/caxri/issues/77).
- **Remediation target / Acceptance:** Single dirty source of truth, or clear durable `openTabs.dirty` on bootstrap/open when no recoverable draft content exists. Acceptance: no path leaves `openTabs.dirty=true` without live dirty content or a recoverable draft; UI dots and preview rules agree.

### AD-domain-runtime-index-boundary — [RESOLVED · Architecture debt · M]

- **Summary:** Nested Server domains `files/` and `agents/` lack `index.ts` public surfaces while production and cross-domain code deep-import internals, so Agents cannot predict import boundaries.
- **Evidence:** `apps/server/src/domains/agents/index.ts` and `apps/server/src/domains/files/index.ts` expose the public surfaces; current production consumers import their domain roots. `apps/server/src/domains/__tests__/structure.test.ts:54-92` independently requires barrels for domains with at least three modules and rejects cross-domain deep imports.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 310f068 via [issue caxri#78](https://github.com/tjx666/caxri/issues/78).
- **Remediation target / Acceptance:** Domain `index.ts` barrels for files and agents; production imports only through those surfaces; Terminal launch resolve via public Agents (or executables) export. Acceptance: production Server imports of nested domains resolve only through each domain's `index.ts`.

### AD-ext-agent-display-single-source — [RESOLVED · Architecture debt · S]

- **Summary:** Adding a hosted Agent provider is not one catalog+adapter path: default Terminal titles and hosted icon labels re-declare display strings outside `agentProviderCatalog`.
- **Evidence:** `apps/server/src/domains/session-policy.ts:24-25` and `apps/desktop/src/renderer/src/icons/agents/agent-icon-registry.ts:26-28` derive managed-provider titles and labels from `packages/protocol/src/agent/agents.ts`. Exhaustive catalog coverage lives at `apps/server/src/domains/__tests__/session-policy.test.ts:57-66` and `apps/desktop/src/renderer/src/icons/agents/agent-icon-registry.test.ts:8-21`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 58ebede via [issue caxri#79](https://github.com/tjx666/caxri/issues/79).
- **Remediation target / Acceptance:** Derive default agent Terminal titles (shell remains local) and hosted icon labels from the catalog, or add bi-directional exhaustiveness tests. Acceptance: catalog id + providers registry is enough for default title and displayName consumers; extra icon assets stay the only optional UI step.

### AD-test-runtime-scale-rule-gate — [RESOLVED · Coverage or observability gap · S]

- **Summary:** The Server domain scale / `index.ts` boundary is documented but has no test, lint, or knip gate, so boundary drift stays green under typecheck.
- **Evidence:** `apps/server/src/domains/__tests__/structure.test.ts:54-92` scans direct Server domains, requires `index.ts` at the scale threshold, parses production imports, and rejects cross-domain paths below a domain root. The focused structure test still passes on `main@8037720`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 310f068 via [issue caxri#78](https://github.com/tjx666/caxri/issues/78).
- **Remediation target / Acceptance:** Cheap structure test or eslint/knip boundary rule requiring nested-domain `index.ts` and forbidding production deep cross-domain imports. Acceptance: introducing missing domain `index.ts` or illegal deep imports fails a focused automated check.

### AD-persist-schema-version-hand-sync — [RESOLVED · Architecture debt · M]

- **Summary:** Schema evolution requires hand-keeping Drizzle SQL `?raw` imports, `preservingMigrations`, `CURRENT_SCHEMA_VERSION`, and `app_state.schemaVersion` in sync (drizzle journal meta numbering also diverges), so a missed edit can split fresh vs upgraded DBs.
- **Evidence:** `apps/server/src/domains/db/migrations/manifest.ts` validates the bundled SQL list against Drizzle's journal and derives the baseline and current versions. Since [issue caxri#1324](https://github.com/tjx666/caxri/issues/1324) squashed the pre-release chain into `0000_baseline`, `PRAGMA user_version` is the only stored version and `app_state.schemaVersion` is gone. `apps/server/src/domains/db/__tests__/migration-manifest.test.ts` rejects missing, reordered, or duplicate entries; `apps/server/src/domains/db/__tests__/database.integration.test.ts` covers fresh install, pre-baseline rebuild, and newer-version rejection.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 8301a1a via [issue caxri#81](https://github.com/tjx666/caxri/issues/81).
- **Remediation target / Acceptance:** Derive version and preserving list from migrations meta/journal; one writer for `user_version` and app-state; CI equality gate. Acceptance: new drizzle migration cannot ship without version advancement; upgrade-from-floor coverage remains.

### AD-ui-design-redline-drift — [RESOLVED · Contract drift · M]

- **Summary:** Authoritative DESIGN type/spacing/radius redlines are already violated in chrome primitives and are not lint-enforced, so interaction density drifts by ad-hoc Tailwind literals.
- **Evidence:** `DESIGN.md:25-78` now defines dense type, optical spacing, control-height, radius, platform exceptions, and the closed arbitrary-value policy. `apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts:10-142` recognizes typography, control-height, positive/negative spacing, and radius classes before enforcing the explicit allowlist; it still passes on `main@8037720`.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 1e77c5c via [issue caxri#82](https://github.com/tjx666/caxri/issues/82).
- **Remediation target / Acceptance:** Normalize chrome to meta/base and the 4px grid, or revise DESIGN to admit the dense set; optional ESLint/Tailwind ban for off-contract classes. Acceptance: no Renderer class uses banned sizes/spacings/radii without an explicit DESIGN exception.

### AD-ui-dual-theme-css-bootstrap — [RESOLVED · Architecture debt · S]

- **Summary:** Main workbench and Process Explorer each own a full Tailwind `@theme` bootstrap, so semantic token additions must be dual-edited and already diverge.
- **Evidence:** `apps/desktop/src/renderer/src/styles/theme.css:9-75` is the only semantic Tailwind/default-theme bootstrap. Both `apps/desktop/src/renderer/src/styles/styles.css:1` and `apps/desktop/src/renderer/src/styles/process-explorer.css:1` import it. `apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts:29-52` rejects another `@theme` source or an entry that stops importing the shared file.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ fba7662 via [issue caxri#83](https://github.com/tjx666/caxri/issues/83).
- **Remediation target / Acceptance:** Extract shared theme-bootstrap CSS (unregister + `@theme` + defaults); keep PE-only rules separate. Acceptance: adding a semantic token is a single edit consumed by both entries.

### AD-ui-input-primitive-bypass — [RESOLVED · Architecture debt · M]

- **Summary:** Shared Input encodes the field redline, but dense workbench surfaces reimplement raw `<input>` with different heights and focus treatment, fragmenting interaction chrome.
- **Evidence:** `apps/desktop/src/renderer/src/components/ui/input.tsx` owns `standard`, `dense`, `compact`, and `palette` sizes plus shared appearances and `InputGroup`. Resource Explorer, Project Search, Commit History, Project/Session rename, and Path Browser consume those variants. `apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts` rejects feature-local raw text inputs.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ 1e77c5c via [issue caxri#82](https://github.com/tjx666/caxri/issues/82).
- **Remediation target / Acceptance:** Dense size (and optional adornment) variants on Input; migrate secondarySidebar/search/rename fields. Acceptance: feature-local text fields do not reinvent border/focus/radius; density is a prop on the shared primitive.

### AD-toolchain-shadcn-components-json — [RESOLVED · Contract drift · S]

- **Summary:** `components.json` still declares `baseColor: zinc` and a single CSS path, conflicting with the unregistered-default-palette guarantee and dual renderer CSS entries.
- **Evidence:** `components.json:8-9` now points shadcn at the shared `apps/desktop/src/renderer/src/styles/theme.css`; `DESIGN.md:25-29` documents why immutable `baseColor: zinc` metadata does not re-enable the unregistered default palette. `apps/desktop/src/renderer/__tests__/renderer-theme-contract.test.ts:55-67` locks both properties to the intentional contract.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ fba7662 via [issue caxri#83](https://github.com/tjx666/caxri/issues/83).
- **Remediation target / Acceptance:** Align `components.json` with semantic tokens and shared theme CSS; document PE dual-entry handling. Acceptance: project-guided shadcn add does not reintroduce palette utilities or leave PE bootstrap stale.

### AD-lifecycle-pe-render-recovery — [RESOLVED · Coverage or observability gap · S]

- **Summary:** Process Explorer has no React ErrorBoundary and no Main `render-process-gone` crash-policy, so a PE render throw or renderer crash blanks the diagnostic window without workbench-style recovery.
- **Evidence:** `apps/desktop/src/renderer/src/process-explorer-main.tsx:6-18` wraps the diagnostic app in the shared recoverable `ErrorBoundary`. `apps/desktop/src/main/process-explorer-window.ts:97-124` applies bounded crash-policy reloads and stops a crash loop cleanly. `apps/desktop/src/main/__tests__/crash-policy.test.ts:5-44` covers the backoff budget; `e2e/process-explorer-recovery.e2e.ts:93-151` covers render reload and repeated renderer crashes on real Electron.
- **First seen:** 2026-08-11 @ eb9becb · **Last verified:** 2026-08-13 @ 8037720
- **Resolved:** 2026-08-11 @ bd4f813 via [issue caxri#84](https://github.com/tjx666/caxri/issues/84).
- **Remediation target / Acceptance:** Reuse ErrorBoundary (or PE fallback) on the PE entry; optionally register Main crash recovery for the PE window. Acceptance: forced PE render throw shows recovery UI; process-gone does not leave an unrecovered blank PE indefinitely.

---

## STALE

### AD-test-hyphenated-sibling-discovery — [STALE · Coverage or observability gap · S]

- **Summary:** The original claim that `check --test` silently misses `project-status-runner.test.ts` is no longer true because static direct-import discovery includes that suite.
- **Evidence:** `.agents/skills/quality-check/scripts/check.ts` resolves Renderer aliases and scans static direct imports across applications, skills, scripts, and packages; `apps/server/src/domains/__tests__/project-status-runner.test.ts:3-4` directly imports `../project-status-external`. Exact-stem candidate generation remains intentionally narrower.
- **First seen:** 2026-08-13 @ 940d949 · **Last verified stale:** 2026-08-24 @ 87b613a
- **Disposition:** Do not add broad hyphenated-sibling inference. The distinct alias-import and `apps/cli` discovery gaps remain tracked by [issue caxri#159](https://github.com/tjx666/caxri/issues/159).

---

## Intentional tradeoffs (not debt — do not "fix" without product change)

Recorded so repeat audits do not reclassify them as findings.

| ID                                  | Tradeoff                                                                                                                                                                             | Evidence                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| IT-disk-wins-dirty-buffer           | External disk changes replace dirty editor buffers without a conflict dialog                                                                                                         | architecture / `external-sync`                                                                  |
| IT-unsaved-buffers-not-durable      | Document bodies stay Renderer-local; SQLite holds tab metadata only                                                                                                                  | `session_state` / session-view                                                                  |
| IT-terminal-snapshot-finalization   | Parsed snapshot encoding 3 persists its source grid; unclean Server Core loss may drop latest visual state                                                                           | `apps/server/src/domains/terminal/snapshot-persistence.ts`, TerminalManager                     |
| IT-copy-not-journaled               | `files.copy` is best-effort, may leave partial trees, Main wait non-expiring; create/rename/move are journaled                                                                       | `supervisor.ts`, `mutation-journal`, partial-copy tests                                         |
| IT-project-status-fixed-allowlist   | Project Status CLIs fixed to gh / linear / vc; not a plugin adapter surface                                                                                                          | architecture, `project-status.ts`                                                               |
| IT-pe-flag-redaction-only           | Process Explorer redacts common credential **flag** argv shapes only (best-effort); not full `redactSecretText`                                                                      | `process-explorer.ts` `redactProcessName`                                                       |
| IT-pnpm-12-global-resolver          | pnpm 12 stable cannot globally register the CLI workspace directly, so linking uses a dependency-free package around the verified standalone bundle                                  | `apps/cli/scripts/link-global.ts`                                                               |
| IT-cli-global-wrapper               | Global CLI linking registers a dependency-free wrapper around the verified standalone bundle                                                                                         | `apps/cli/scripts/link-global.ts`                                                               |
| IT-typescript-6-eslint-plus-7-tsc   | typescript package aliases TS6 for eslint; `@typescript/native` supplies TS7 tsc                                                                                                     | electron-toolchain / stack-baseline                                                             |
| IT-electron-vite-beta               | electron-vite 6 beta accepted for Vite 8 + utilityProcess                                                                                                                            | package.json, electron-toolchain.md                                                             |
| IT-runtime-integration-not-inferred | `check` does not map every `apps/server/src/domains/*.ts` edit onto the historical `runtime.integration.test.ts` compatibility test                                                  | `check.ts`, `check.test.ts`                                                                     |
| IT-window-level-error-boundary      | Render exceptions recover via a window-level ErrorBoundary plus reload; only the editor pane nests one, so a failed lazy tab stays in its pane                                       | `error-boundary.tsx`, Renderer entries, `editor-error-boundary.tsx`                             |
| IT-eslint-renderer-import-gate      | Renderer Node/Electron isolation is ESLint `no-restricted-imports` plus sandbox, not a bundle AST walk                                                                               | `eslint.config.ts`, `BrowserWindow` webPreferences                                              |
| IT-go-cooperative-ledger            | Go receipts validate cooperative exact-head state and lineage; they do not execute commands, derive findings, or form an adversarial security boundary                               | `.agents/skills/go/SKILL.md`                                                                    |
| IT-single-self-hosted-runner        | One machine owns all CI/Release labels with queued offline behavior and no hosted fallback; this is an availability/cost tradeoff, not a security boundary                           | `docs/self-hosted-runner.md`                                                                    |
| IT-ci-workflow-source-contract      | Ordinary workflow contracts use source-shape/order smoke assertions; trust clauses have structured YAML binding, and neither layer evaluates arbitrary GitHub expression equivalence | `ci-workflow-contract.test.ts`, `ci-trust-policy.test.ts`                                       |
| IT-skill-shared-redaction-helper    | Repository skill scripts reuse the browser-safe shared redaction helper instead of duplicating secret-shape policy in a skill-only package                                           | `note-safety.ts`, `packages/utils/src/redaction.ts`                                             |
| IT-runner-cleanup-primary-error     | Runner cleanup attempts every stage, reports all failed stages in the summary, and throws the first causal error rather than changing the CLI contract to `AggregateError`           | `self-hosted-runner.ts`, `self-hosted-runner.test.ts`                                           |
| IT-e2e-build-input-roots            | E2E build freshness uses audited coarse repository roots rather than parsing the Vite dependency graph; confirmed missing consumed roots are defects                                 | `e2e/support/build-freshness.ts`, [issue caxri#335](https://github.com/tjx666/caxri/issues/335) |
| IT-e2e-worker-local-error-gate      | `E2EErrorGate` state is isolated per Playwright worker process; pool orchestration may use more than one worker                                                                      | `e2e/support/error-gate.ts`, `scripts/run-e2e-pools.ts`                                         |
| IT-e2e-parallel-safe-allowlist      | Only individually audited specs enter the two-worker allowlist; every unclassified spec fails closed to the desktop-exclusive pool                                                   | `e2e/support/pools.ts`, `docs/ci-performance.md`                                                |

---

## Current priority guide (OPEN at 2026-08-16)

Every tracked OPEN entry is resolved. New incremental-audit findings are routed through dedicated
follow-up issues so their lifecycle and acceptance evidence remain independently reviewable.

## Historical priority guide (all resolved)

Retained to explain the original execution order used by [PR caxri#101](https://github.com/tjx666/caxri/pull/101).

**Top priorities:** `AD-persist-non-atomic-document-save` → `AD-sec-config-disk-size-cap` → `AD-state-dual-editor-dirty` → `AD-domain-runtime-index-boundary` + `AD-test-runtime-scale-rule-gate` → `AD-ext-agent-display-single-source`.

**Quick wins (S):** scale-rule gate · agent display single-source · shared theme CSS · `components.json` · PE ErrorBoundary · config disk size cap + tests.

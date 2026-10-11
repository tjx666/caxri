---
kind: living
status: current
---

# Unified Quality Toolchain

Durable record of Caxri's mechanical-quality tooling after
[issue #177](https://github.com/tjx666/caxri/issues/177): what each tool owns, where a given
`AGENTS.md`/skill convention is actually enforced, what stays a prose-only judgment, and how the
negative-fixture contract tests keep the wiring from silently rotting.

## Tool ownership matrix

| Concern                                                                   | Owning tool                                                                                                                                                                                     | Command                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Code formatting (JS/TS/CSS/JSON/YAML/HTML)                                | Prettier (`@yutengjing/prettier-config`)                                                                                                                                                        | `bun run format` / `format:check`       |
| Markdown formatting                                                       | Prettier (`prettier --write "**/*.md"`)                                                                                                                                                         | `bun run format:md` / `format:md:check` |
| Markdown lint semantics (headings, links, lists)                          | markdownlint-cli2 (`.markdownlint-cli2.jsonc`)                                                                                                                                                  | `bun run lint:markdown`                 |
| Syntactic JS/TS rules, import boundaries, local custom rules              | ESLint (`eslint.config.ts`), deliberately runs without typed linting (`projectService`)                                                                                                         | `bun run lint`                          |
| Type-aware JS/TS rules (`typescript/*`, plus `node/no-sync`)              | oxlint + tsgolint (`.oxlintrc.json`)                                                                                                                                                            | `bun run lint:type-aware`               |
| Directory/domain/naming contracts too structural for a single ESLint rule | Vitest repository-contract tests (`scripts/__tests__/*.test.ts`, `apps/server/src/domains/__tests__/structure.test.ts`, `apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts`) | `bun run test`                          |
| Type correctness                                                          | `tsc --noEmit` (`tsconfig.node.json` / `tsconfig.web.json`) plus workspace `typecheck`                                                                                                          | `bun run typecheck`                     |

ESLint owns anything expressible as a syntactic rule over a single file; every rule that needs
type information runs through `oxlint --type-aware` instead (see
`docs/type-aware-linting.md` for the split's rationale, the enabled rule set, and the
`docs/oxlint-spike.md` evidence that preceded it). Vitest
contract tests own anything that needs to walk the tree, compare multiple files, or assert on
`package.json`/`pnpm-workspace.yaml` shape, the same split the pre-existing `workspace-contract`,
Server `structure`, and Renderer `design-contract` tests already used.

## Where each convention is enforced

### Already enforced before this stage

| Convention                                                                                       | Enforcement                                                                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Renderer never imports Node/Electron/native APIs                                                 | `eslint.config.ts` `no-restricted-imports` scoped to `apps/desktop/src/renderer/**` |
| 800 physical line cap                                                                            | `eslint.config.ts` `max-lines`                                                      |
| 600-line growth ratchet: a changed source file may not grow to or past 600 lines                 | `scripts/source-size-ratchet.ts`                                                    |
| No default export on `.tsx` under `src/`                                                         | `eslint.config.ts` `no-restricted-syntax` (`ExportDefaultDeclaration`)              |
| `packages/protocol` stays browser-safe; `apps/cli` production graph excludes Desktop native deps | `scripts/__tests__/workspace-contract.test.ts`                                      |
| protocol/CLI locked domain lists and barrels                                                     | `scripts/__tests__/workspace-contract.test.ts`                                      |
| CLI tests live in `__tests__/`, not loose beside production files                                | `scripts/__tests__/workspace-contract.test.ts`                                      |
| Server domains with 3+ modules need a barrel; no cross-domain deep import                        | `apps/server/src/domains/__tests__/structure.test.ts`                               |
| Tailwind arbitrary typography, spacing, and radius values stay on the DESIGN.md allowlist        | `apps/desktop/src/renderer/__tests__/renderer-design-contract.test.ts`              |
| Tailwind color utilities name a token registered in `theme.css`'s `@theme inline` bridge         | `eslint.config.ts` `caxri/registered-color-utilities`                               |

### New in this stage (issue #177 stage 5)

| Convention                                                                                                                                             | Enforcement                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@/*` and `@desktop-shared/*` aliases are Renderer-only; other application code uses relative imports internally and package exports across boundaries | `eslint.config.ts` `no-restricted-imports` and architecture-boundary fixtures                                                                                                                          |
| No `child_process` `exec`/`execSync` (shell-string execution); structured argv `spawn`/`execFile` stays allowed                                        | `eslint.config.ts` `no-restricted-imports` (named-import ban on `exec`/`execSync` from `child_process`/`node:child_process`), with distinct application and tooling/package scopes                     |
| No `spawn`/`execFile` with `shell: true`                                                                                                               | `eslint.config.ts` `no-restricted-syntax` selector matching a `shell: true` option object, same directory scope as above, `.tsx` excluded to avoid colliding with the default-export-ban config object |
| Async-first system APIs (`*Sync` needs a justifying comment)                                                                                           | oxlint's `node/no-sync`, scoped to Desktop Main, Server, `packages/system`, CLI, scripts, and skill scripts, excluding tests                                                                           |
| Component/hook filename maps to its primary export (`file-tree.tsx` → `FileTree`, `use-command-shortcuts.ts` → `useCommandShortcuts`)                  | Local `caxri/filename-export-mapping` ESLint rule (`scripts/eslint-rules/filename-export-mapping.ts`, plugin barrel `scripts/eslint-rules/index.ts`), wired for `src/**/*.tsx` and `src/**/use-*.ts`   |
| Desktop/Server/shared system tests live in `__tests__/`, not loose beside production files (Renderer colocated tests stay allowed)                     | `scripts/__tests__/test-placement-contract.test.ts`                                                                                                                                                    |
| No `*.test.tsx` anywhere (components are not unit-tested; logic gets extracted)                                                                        | `scripts/__tests__/test-placement-contract.test.ts`                                                                                                                                                    |

### After stage 5

| Convention                                                                                                                      | Enforcement                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class methods have a blank line on either side; consecutive fields and overload signatures may pack                             | `eslint.config.ts` `@stylistic/lines-between-class-members` (Prettier never inserts these blank lines)                                                                    |
| Renderer server reads go through React Query, a `*-client.ts`, or a `*-commands.ts` module, never straight into component state | Local `caxri/server-reads-through-query` ESLint rule (`scripts/eslint-rules/server-reads-through-query.ts`), scoped to all of `apps/desktop/src/renderer/src/features/**` |

Flat ESLint config objects replace, rather than merge, a later matching object's same-named rule
for a given file. The two `no-restricted-imports` blocks above stay on non-overlapping `files`
globs (Desktop `src/` subtrees vs. `scripts`/`.agents`/`e2e`/`packages`) instead of one broad glob,
and the `shell: true` `no-restricted-syntax` block excludes `.tsx` so it never collides with the
pre-existing default-export-ban block on the same directories. See the comments in
`eslint.config.ts` at each of these blocks for the specific collision each scoping choice avoids.

## Deferred (not implemented in this stage)

| Item                                                                                             | Reason                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@yutengjing/prefer-jsdoc` (from `@yutengjing/eslint-plugin`)                                    | Its autofix would rewrite comments repository-wide immediately after the stage-4 Prettier/formatting baseline landed; adopt it as its own staged, reviewable change instead of folding a repo-wide comment rewrite into this stage. |
| Cohesive-cluster / product-UI placement judgment                                                 | Requires product and architectural context a mechanical rule cannot evaluate; stays in `source-layout`/`project-architecture` skill prose and code review.                                                                          |
| Workaround justification quality                                                                 | A disable comment or `// oxlint-disable-next-line node/no-sync -- <reason>` can be mechanically required to _exist_, but whether the stated reason is actually correct is a review judgment.                                        |
| Remote authorization / Acceptance decisions                                                      | Process and authority judgments (`AGENTS.md` standing orders, `go`/`acceptance` skills), not file-shape facts.                                                                                                                      |
| English/Chinese language rules                                                                   | Requires understanding prose content, not syntax.                                                                                                                                                                                   |
| "Thin barrel" judgment (`index.ts` should not become a multi-module dump)                        | Line count and import shape do not distinguish a legitimately thin barrel from a barrel that re-implements logic; stays a `source-layout` review judgment.                                                                          |
| Drop-parent-prefix naming judgment (`command-catalog.ts` → `catalog.ts` once inside `commands/`) | Whether a prefix "still distinguishes siblings" depends on the folder's actual contents at review time, not a fixed pattern.                                                                                                        |

## How the negative-fixture contract tests guard the wiring

`scripts/__tests__/eslint-toolchain-contract.test.ts` lints small fixtures under
`scripts/fixtures/eslint/` directly with `ignore: false` (bypassing the `globalIgnores` entry that
keeps them out of the repository's own `--max-warnings=0` gate) and asserts the exact `ruleId`
each one is supposed to trip. A new fixture must also be listed in `package.json`
`knip.workspaces["."].entry` (exact path or glob); Knip cannot see string-literal fixture paths
and will fail CI on an unused file. Every new rule in this stage has a paired positive fixture
(silent) and negative fixture (fires):

- `child-process-exec-fixture.ts` / `spawn-shell-true-fixture.ts`: trip the `exec`/`execSync`
  import ban and the `shell: true` syntax ban.
- `good-mapped-component-fixture.tsx` / `bad-mapped-component-fixture.tsx` and
  `use-good-mapped-hook-fixture.ts` / `use-bad-mapped-hook-fixture.ts`: stay silent or fire
  `caxri/filename-export-mapping` depending on whether the file's primary export matches its
  filename mapping.
- `class-members-packed-methods-fixture.ts` / `class-members-spaced-methods-fixture.ts`: fire or
  stay silent for `@stylistic/lines-between-class-members` depending on whether adjacent methods
  have a blank line (packed consecutive fields and overload signatures stay allowed).
- `view-container-reads/component-state-read-fixture.ts` (both `caxri.request` and the abortable
  `caxri.requestWithSignal`) and `view-container-reads/tree-branch-actions.ts` vs.
  `view-container-reads/query-function-read-fixture.ts`,
  `view-container-reads/tree-branch-client.ts`, and
  `view-container-reads/tree-branch-commands.ts`: fire or stay silent for
  `caxri/server-reads-through-query`, asserted by
  `scripts/__tests__/server-reads-through-query.test.ts` rather than the shared contract test. The
  `-actions.ts` fixture pins the filename convention itself: only `*-client.ts` and `*-commands.ts`
  name a data layer, so a request relocated into a feature's UI-action module is still reported.

The Renderer-only alias ban is asserted through `ESLint#calculateConfigForFile`
(`effectiveConfigFor` in the same test file) instead of a fixture, mirroring how the pre-existing
tests already assert `max-lines`/`no-restricted-imports` are wired onto a representative Renderer
file: the rule applies to real production directories, so proving the _effective config_ carries
it is enough; no throwaway fixture is needed.

`scripts/__tests__/oxlint-toolchain-contract.test.ts` guards the oxlint side of the split the same
way: `type-aware-violation.ts` must trip `typescript/no-floating-promises` under
`oxlint --type-aware` (and stay ESLint-silent), `no-sync-fixture.ts` must trip `node/no-sync`, and
`.oxlintrc.json` itself is asserted to keep every default category off so oxlint never re-lints
syntactic territory ESLint owns.

This pairing is what makes the stage-5 rules durable: if a future `eslint.config.ts` edit
accidentally drops or misscopes one of these blocks (for example, by letting a later config object
silently replace an earlier `no-restricted-imports`/`no-restricted-syntax` entry; see "Where each
convention is enforced" above), the corresponding contract test fails immediately instead of the
gap surfacing only when a real violation ships.

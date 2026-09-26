---
name: source-layout
description: Place, split, and rename Caxri source files against the repository directory and naming contracts. Use when adding a module or React component, creating a folder, moving files after a split, choosing __tests__ vs colocated tests, naming a barrel or generated file, or when the user asks about 文件结构, 目录约定, 平铺, or where a file should live. Do not use for process, IPC, or persistence decisions.
---

# Source Layout

Decide where a file lives, what it is named, and how its tests sit beside it. Top-level roots are
the `AGENTS.md` repository layout table. `project-architecture` owns process and IPC meaning. This
skill owns placement inside those roots.

## 1. Pick the tree

The current topology has one independently runnable product per `apps/*` workspace and only
importable boundaries under `packages/*`:

| Work                             | Target path                      |
| -------------------------------- | -------------------------------- |
| Desktop                          | `apps/desktop/`                  |
| Server                           | `apps/server/`                   |
| CLI                              | `apps/cli/`                      |
| Mobile companion                 | `apps/mobile/`                   |
| Shared Client                    | `packages/client/src/`           |
| Protocol schemas and registry    | `packages/protocol/src/`         |
| Extension API                    | `packages/extension-api/src/`    |
| Shared system primitives         | `packages/system/src/`           |
| Browser-safe pure utilities      | `packages/utils/src/`            |
| Mobile transport and wire format | `packages/mobile-transport/src/` |
| Markdown rendering pipeline      | `packages/markdown/src/`         |
| Agent skill installation         | `packages/agent-skills/src/`     |

Do not create an empty future application. The repository root owns no product `src/` tree. The
executable source of truth for ownership is `scripts/architecture-boundaries.ts`.
`caxri/architecture-boundaries` rejects application-to-application source imports, package-private
imports, and platform dependencies in browser-safe packages; `import-x/no-cycle` protects current
workspaces. Renderer never imports Node.js, Electron, or native APIs. The `@` and
`@desktop-shared` path aliases exist only in the Renderer TypeScript project (`tsconfig.web.json`)
and Vitest; other application code uses relative imports internally and public package exports
across ownership boundaries. Playwright support stays in `e2e/support/`. Contributor skills live
at `.agents/skills/<name>/`.

## 2. Place React components

| Kind                                        | Live here                                           |
| ------------------------------------------- | --------------------------------------------------- |
| Feature screen, panel, or dialog            | `apps/desktop/src/renderer/src/features/<feature>/` |
| Shared chrome used by more than one feature | `apps/desktop/src/renderer/src/components/`         |
| shadcn primitives                           | `apps/desktop/src/renderer/src/components/ui/`      |
| Shared hooks                                | `apps/desktop/src/renderer/src/hooks/`              |
| Icons                                       | `apps/desktop/src/renderer/src/icons/`              |

Do not put product UI in `components/ui/`. Do not invent a second hooks directory; `@/hooks` is
`apps/desktop/src/renderer/src/hooks/`. Process Explorer UI stays under `features/process-explorer/`
with its own entry.

A component file is kebab-case `.tsx`; its primary named export is the PascalCase mapping of the
filename (`file-tree-panel.tsx` exports `FileTreePanel`). No default export. Extract state and
commands into a sibling `.ts` module or hook; do not grow a `.tsx` into a logic dump. Styling
follows `DESIGN.md` token utilities only.

## 3. Shape a Renderer feature directory

A feature directory under `apps/desktop/src/renderer/src/features/<feature>/` starts flat and earns
a kind folder only when files of that kind accumulate. The `caxri/feature-directory-structure`
ESLint rule enforces the thresholds and the no-coexistence contract.

| Kind                  | Flat form (fewer than three) | At three or more                    |
| --------------------- | ---------------------------- | ----------------------------------- |
| Tests                 | Colocated `foo.test.ts`      | This directory's `__tests__/`       |
| Feature-local hooks   | `use-*.ts` beside consumers  | `hooks/`                            |
| Feature-local helpers | `utils.ts`                   | `utils/` with semantic module names |

- The flat form and the folder never coexist. Once `__tests__/` exists, no colocated `*.test.ts`
  stays behind; once `hooks/` exists, every feature-local hook moves in; `utils.ts` and `utils/`
  are mutually exclusive. An existing directory below a threshold is not folded back.
- `types.ts` / `constants.ts` exist only for contracts shared by several modules of the feature. A
  type or constant owned by one module stays in that module.
- A helper enters `utils` only when its semantics are feature-specific. Generic helpers still
  follow the shared ladder: `es-toolkit` first, then `@caxri/utils`; a hook used by a second
  feature moves to `@/hooks`.
- When a feature grows a cohesive sub-domain, split by sub-domain (`view-containers/source-control/`)
  before piling onto kind folders: kind folders solve "too many files of one kind", sub-domains
  solve "the feature itself is too big". Each sub-domain directory applies the same scale rules.

## 4. Scale before creating a folder

A new cluster may stay flat while it has at most two production modules. At three or more cohesive
modules it owns a directory, exposes a thin `index.ts` barrel, and keeps tests in that directory's
`__tests__/` (Renderer feature directories follow the section 3 thresholds instead). Do not invent
a folder for a one- or two-file cluster.

Locked protocol and CLI domains in the `project-architecture` architecture reference stay even
when they have only two production modules. Do not add or remove one of those domains without
updating that reference and `scripts/__tests__/workspace-contract.test.ts`. A new Server domain
with three or more modules needs a barrel; `apps/server/src/domains/__tests__/structure.test.ts`
rejects a missing one and rejects production imports that reach past another domain's root.

## 5. Name files for the job

- After a file enters a domain folder, drop the parent-name prefix: `command-catalog.ts` becomes
  `catalog.ts`, `host-client.ts` becomes `client.ts`.
- Keep a prefix only when it distinguishes siblings in the same folder (`commands/skills.ts`).
- `index.ts` is a thin public barrel. Implementation stays in named files. Do not dump a
  multi-module domain into `index.ts`.
- Generated sources use a `.generated.ts` suffix and no redundant parent prefix once they already
  live inside that domain.
- Prefer named exports. React components under `src/` must not use default exports.
- All JavaScript/TypeScript files use kebab-case basenames; there is no exception for React
  components or hooks. The primary named export is the semantic-casing mapping of the filename:
  `file-tree-panel.tsx` exports the component `FileTreePanel`; `use-command-shortcuts.ts` exports
  the hook `useCommandShortcuts`; a compound-component file like `context-menu.tsx` exports the
  primary component `ContextMenu`.
- Role suffixes (`.test`, `.config`, `.generated`, `.e2e`, `.fixture`, `.integration.test`, etc.)
  are preserved as dot segments after the kebab-case stem.
- Composition entrypoints (`index.ts`, `main.tsx`, and similar) are not required to match a
  primary export.
- When a component and its sibling logic or store module would otherwise share a stem
  (`file-conflict-dialog.tsx` next to `file-conflict-dialog.ts`), the module specifier becomes
  ambiguous; give the sibling logic/store module a distinguishing suffix, e.g.
  `file-conflict-dialog-store.ts`.

Cross-domain production imports target the domain barrel, not a deep file. Package consumers use
the package root; `apps/cli/src` composition-root files (`application`, `environment`, `output`,
`selectors`) stay at that root and are not an importable package boundary.

When moving, `git mv`, then fix relative imports and `import.meta.url` paths in the same change.

## 6. Place tests

| Surface                        | Tests                                          |
| ------------------------------ | ---------------------------------------------- |
| Renderer feature logic         | Colocated below three files, else `__tests__/` |
| React components               | Do not unit-test the `.tsx`; extract logic     |
| Renderer-wide contracts        | `apps/desktop/src/renderer/__tests__/`         |
| Desktop, Server, packages, CLI | Domain-local `__tests__/`                      |
| Skill scripts                  | `scripts/*.test.ts` or `scripts/__tests__/`    |
| Repo scripts                   | `scripts/__tests__/`                           |
| Electron workflows             | `e2e/*.e2e.ts`                                 |

Do not leave `*.test.ts` beside production files outside the Renderer. For test execution guidance,
Call the Skill tool with "unit-testing" or "e2e-testing" as applicable. Rendering and interaction
belong to `e2e-testing`.

## 7. Finish

If a file is approaching 800 physical lines, split a cohesive module before the `max-lines` gate.
Call the Skill tool with "quality-check" on the moved set. If the change adds or removes a locked
domain name, update the contract test that owns that list in the same change.

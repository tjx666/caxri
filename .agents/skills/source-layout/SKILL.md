---
name: source-layout
description: Place, split, and rename Caxri source files against the repository directory and naming contracts. Use when adding a module or React component, creating a folder, moving files after a split, choosing __tests__ vs colocated tests, naming a barrel or generated file, or when the user asks about 文件结构, 目录约定, 平铺, or where a file should live. Do not use for process, IPC, or persistence decisions.
---

# Source Layout

Decide where a file lives, what it is named, and how its tests sit beside it. Top-level roots are
the `AGENTS.md` repository layout table. `project-architecture` owns process and IPC meaning. This
skill owns placement inside those roots.

## 1. Pick the tree

| Work                          | Live here                |
| ----------------------------- | ------------------------ |
| Host                          | `src/host/`              |
| Desktop Main                  | `src/main/`              |
| Preload                       | `src/preload/`           |
| Renderer                      | `src/renderer/src/`      |
| Runtime                       | `src/runtime/`           |
| Browser-safe shared contracts | `src/shared/`            |
| Node-only shared helpers      | `src/shared/node/`       |
| Protocol schemas and registry | `packages/protocol/src/` |
| CLI adapter                   | `packages/cli/src/`      |

`src/shared/ipc/` is a compatibility re-export layer; it must not define a second method or schema
table. Renderer never imports Node, Electron, or native APIs. Playwright support stays in
`e2e/support/`. Contributor skills live at `.agents/skills/<name>/`.

## 2. Place React components

| Kind                                        | Live here                              |
| ------------------------------------------- | -------------------------------------- |
| Feature screen, panel, or dialog            | `src/renderer/src/features/<feature>/` |
| Shared chrome used by more than one feature | `src/renderer/src/components/`         |
| shadcn primitives                           | `src/renderer/src/components/ui/`      |
| Shared hooks                                | `src/renderer/src/hooks/`              |
| Icons                                       | `src/renderer/src/icons/`              |

Do not put product UI in `components/ui/`. Do not invent a second hooks directory; `@/hooks` is
`src/renderer/src/hooks/`. Process Explorer UI stays under `features/process-explorer/` with its
own entry.

A component file is kebab-case `.tsx`; its primary named export is the PascalCase mapping of the
filename (`file-tree-panel.tsx` exports `FileTreePanel`). No default export. Extract state and
commands into a sibling `.ts` module or hook; do not grow a `.tsx` into a logic dump. Styling
follows `DESIGN.md` token utilities only.

## 3. Scale before creating a folder

A new cluster may stay flat while it has at most two production modules. At three or more cohesive
modules it owns a directory, exposes a thin `index.ts` barrel, and keeps tests in that directory's
`__tests__/` (Renderer excepted). Do not invent a folder for a one- or two-file cluster.

Locked protocol and CLI domains in `AGENTS.md` stay even when they have only two production
modules. Do not add or remove one of those domains without updating `AGENTS.md` and
`scripts/__tests__/workspace-contract.test.ts`. A new Runtime domain with three or more modules
needs a barrel; `src/runtime/__tests__/structure.test.ts` rejects a missing one and rejects
production imports that reach past another domain's root.

## 4. Name files for the job

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
the package root; `packages/cli/src` composition-root files (`application`, `environment`,
`output`, `selectors`) stay at that root.

When moving, `git mv`, then fix relative imports and `import.meta.url` paths in the same change.

## 5. Place tests

| Surface                          | Tests                                       |
| -------------------------------- | ------------------------------------------- |
| Renderer feature logic           | Colocated `foo.test.ts` beside `foo.ts`     |
| React components                 | Do not unit-test the `.tsx`; extract logic  |
| Renderer-wide contracts          | `src/renderer/__tests__/`                   |
| Main, Host, Runtime, shared, CLI | Domain-local `__tests__/`                   |
| Skill scripts                    | `scripts/*.test.ts` or `scripts/__tests__/` |
| Repo scripts                     | `scripts/__tests__/`                        |
| Electron workflows               | `e2e/*.e2e.ts`                              |

Do not leave `*.test.ts` beside production files outside the Renderer. How to write or run tests
is `unit-testing` or `e2e-testing`. Rendering and interaction belong to `e2e-testing`.

## 6. Finish

If a file is approaching 800 physical lines, split a cohesive module before the `max-lines` gate.
Run `quality-check` on the moved set. If the change adds or removes a locked domain name, update
the contract test that owns that list in the same change.

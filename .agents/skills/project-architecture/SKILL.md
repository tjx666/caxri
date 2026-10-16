---
name: project-architecture
description: Navigate Caxri's process, persistence, security, product, and toolchain architecture. Use when locating the owning process, changing IPC or Runtime boundaries, modifying persistence, paths, PTYs, files, Git, Agents, recovery, or dependency/toolchain decisions, adding or upgrading dependencies, or updating architecture contracts.
---

# Project Architecture

Choose the topic that owns the current decision. Read that reference first; follow another topic
only when the implementation crosses its boundary. For an unfamiliar area, resolve current owner
paths with `rg --files` or `rg -l`, then search those verified files with `rg -n` before bounded reads.
If a remembered path is missing, inventory the owner again instead of trying another guessed path.
Do not concatenate the reference directory or load every topic as
baseline context. [The architecture index](references/architecture.md) preserves the broader map.

| Decision                                                                   | Read                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Project, Session, Workbench Root, deletion, notifications                  | [Product model](references/product-model.md)               |
| Main / Server / Host ownership, profile, Desktop lease, process restart    | [Process model](references/process-model.md)               |
| Typed requests, capabilities, events, Preload, error boundaries            | [IPC](references/ipc.md)                                   |
| Package imports, mobile boundary, Server domain placement and composition  | [Packages](references/packages.md)                         |
| Human CLI, Agent CLI authority, distributed skill                          | [CLI](references/cli.md)                                   |
| SQLite, schema, durable Session state, Terminal snapshots                  | [Persistence](references/persistence.md)                   |
| PTY launch, Shell observation, suspension, detach, restore                 | [Terminal lifecycle](references/terminal-lifecycle.md)     |
| PTY input/backpressure, file links, split layout, Terminal actions         | [Terminal interaction](references/terminal-interaction.md) |
| Path authorization, symlinks, free-path browsing, create/move/save         | [Files and paths](references/files-and-paths.md)           |
| Editor buffers, external changes, project search, diff surfaces            | [Editor and search](references/editor-and-search.md)       |
| Settings persistence, keybindings, theme tokens                            | [Settings and themes](references/settings-and-themes.md)   |
| Git scopes, worktree attribution, history, diff exclusions, Project Status | [Git](references/git.md)                                   |
| Provider catalog, Agent identity, automatic/manual names, managed Shell    | [Agent identity](references/agent-identity.md)             |
| Agent Endpoint grants, peer messages, dispatch, human steering             | [Agent messaging](references/agent-messaging.md)           |
| Provider lifecycle hooks, generation fencing, bridge trust and install     | [Agent hooks](references/agent-hooks.md)                   |
| Browser isolation, native folder grants, free-path security                | [Security](references/security.md)                         |
| Hot-path costs, startup and Renderer benchmarks                            | [Performance](references/performance.md)                   |
| Log privacy, event catalog, diagnostic retention, GPU recovery             | [Diagnostics](references/diagnostics.md)                   |

For delegated work, give each reviewer the topic paths for its assigned dimensions, not the full
architecture corpus. Reviewers may follow adjacent contracts as their evidence requires. Measure
changes to this routing with the same scoped task, actual returned read bytes, and answer coverage;
file size alone does not establish task savings or quality.

- Read [references/stack-baseline.md](references/stack-baseline.md) when selecting or upgrading
  dependencies, including `ni` catalog mode and the TypeScript 6/7 alias.
- Read [references/electron-toolchain.md](references/electron-toolchain.md) for the Electron, Vite,
  packaging, native-module, and TypeScript toolchain decision.
- Call the Skill tool with "competitors" to survey how competing agent workbenches solved a design
  problem before inventing a new approach. Do this before designing or implementing a substantial
  new product feature; do not invent a new interaction pattern first.
- Call the Skill tool with "source-layout" to place, split, or rename source files.

Before changing a contract, identify the owning process and verify the current implementation.
Update the matching reference in the same change when the architecture or toolchain contract
changes. Root `DESIGN.md` is reserved for frontend and UI design. Mechanical enforcement of
package, import, and domain locks lives in ESLint and
`scripts/__tests__/workspace-contract.test.ts`. Prefer asynchronous Node.js APIs over `*Sync`
variants in Main, Server, and tooling code; test code is exempt, and a deliberately synchronous
production boundary needs a comment justifying it.

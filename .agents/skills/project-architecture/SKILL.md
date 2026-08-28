---
name: project-architecture
description: Navigate Caxri's process, persistence, security, product, and toolchain architecture. Use when locating the owning process, changing IPC or Runtime boundaries, modifying persistence, paths, PTYs, files, Git, Agents, recovery, or dependency/toolchain decisions, adding or upgrading dependencies, or updating architecture contracts.
---

# Project Architecture

Load only the reference needed for the current decision:

- Read [references/architecture.md](references/architecture.md) for product ownership, process
  boundaries, IPC, package ownership, persistence, PTY, files, Git, Agent, security, performance,
  diagnostics, and recovery contracts.
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

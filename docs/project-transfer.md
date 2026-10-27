---
kind: living
status: current
---

# Project transfer

**Export Projects and Sessions…** and **Import Projects and Sessions…** (Project menu and command
palette, local machine only) move the Project and Session list between databases: to another Mac,
or across an update that clears data (see
[Updates that clear data](desktop-updates.md#updates-that-clear-data)).

## What the file holds

The export is a JSON document (`format: "caxri.projects"`, `formatVersion: 1`) defined in
`packages/protocol/src/desktop/project-transfer-contract.ts`. It carries only facts that do not depend on the
database schema, so a build with a newer baseline can still read it:

- each visible top-level Project's root path, in PrimarySidebar order;
- each unarchived Session's title, whether that title is automatic or manual, whether it is pinned,
  and the linked worktree it worked in (its Workbench Root), if any;
- each Agent Terminal bound to a provider conversation: provider, surface (Chat or PTY), the folder
  the Agent worked in, the conversation ID, and a Chat rewind point.

Left out: hidden Projects, archived Sessions, Caxri Bot's own Project, Project icons and colors,
Shell Terminals, layouts, editor state, drafts, usage, and benchmark data. Conversations themselves
stay in each provider's own store; the file only points at them.

## Import

Implemented in `apps/server/src/domains/project/transfer.ts`.

- A Project whose folder no longer exists is skipped as `missing`; one already in the list is
  skipped as `exists`, so importing the same file twice never duplicates Sessions.
- Sessions get new IDs and keep their order and pins. A Session whose worktree is gone opens in
  its Project root and is reported in `missingWorkbenchRoots`.
- Agent Terminals are recreated parked, bound to the same conversation, and resume it when the
  Session opens, provided the provider still has that conversation on this machine. A working
  folder outside the Project and worktree roots falls back to the Session's root.

The Renderer reports the counts and lists up to five skipped paths.

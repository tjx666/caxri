---
kind: adr
status: accepted
---

# One pane tree for Terminals and documents

- Date: 2026-08-21
- Refs: [#257](https://github.com/tjx666/caxri/issues/257)
- Amended by: ADR 0005 (target, pending)
- Amended by: [ADR 0013](0013-editable-external-documents.md) (external documents are editable)

The Workbench renders exactly one of two mutually exclusive split trees (Terminals or Editors)
behind a single global tab strip, so a running Agent and the file it is editing can never be visible
at the same time. Terminals and documents are equally first-class in Caxri, so the two trees merge
into one pane tree. Every pane owns its own tab bar, and a tab's kind decides what the pane renders
and, per [Tab sizing](#tab-sizing), how wide its own tab grows; splitting, drag and drop, closing,
and navigation share one layout model. Editor path drops into Terminal content are an input action,
as described below.

## Identity

Three layers, deliberately separated, because today's `WorkItem` collapses them into one id and that
is what forces every asymmetry:

- **Pane**: a leaf of the tree; owns a tab bar, an active tab, and a fraction of the surface.
- **Tab (occurrence)**: one appearance of a resource in one pane; owns ordering, selection, close,
  DOM identity, and motion.
- **Resource**: the thing being shown; owns the PTY process, the document model and its dirty
  buffer, and Monaco's language services.

`PaneResource` is a two-way union: `{ kind: 'file', path }` or `{ kind: 'terminal', terminalId }`.
Diffs and transcripts stay `file` resources named by a virtual URI scheme
(`caxri-git-diff://…`, `caxri-agent-transcript://…`, recognized by `isVirtualEditorTabPath`)
rather than becoming their own `PaneResource` kinds: they already behave like documents (openable,
closable, repeatable, never read or written through `files.*`), so a third and fourth kind would
duplicate the `file` branch everywhere without buying new behavior.

## Instance versus document

The one asymmetry that survives is a property of the resource, not of the layout:

- A Terminal is an **instance**. Its PTY exists once, so it appears in exactly one pane of a layout.
- A file, diff, or transcript is a **document**. It is `repeatable`: the same resource may occupy
  several panes at once, each occurrence with its own tab id, cursor, scroll, and reveal state,
  while content and dirty state stay shared.

Dragging for pane placement **moves** an occurrence, for every kind. Duplication is a separate, explicit command
(`Open in New Pane`) offered only by repeatable resources. The generic tree reducer therefore never
inspects a tab's kind; only the resource capability table does.

An Editor tab with a filesystem path dragged onto a running Terminal's content pastes that path,
including at its edges. Hold Option to use pane placement instead: the center moves the tab and an
edge splits it. Terminal tab drags and tab-bar reordering retain their existing placement behavior.
Path insertion uses the Terminal's launch directory and shell quoting without submitting a command;
a stopped Terminal rejects it. External documents (read-only until ADR 0013) use their Main-authorized cached path,
which is also available through the tab's Copy Path menu. Virtual documents with no single file
retain pane placement because they have no filesystem path to paste.

## Focus

Three pieces of state replace the single global active item:

- `pane.activeTabId`: what each pane shows. Persisted.
- `layout.activePaneId`: the last active pane, used to restore and as the fallback target.
  Persisted.
- `focusedPaneId`: the pane that actually owns the keyboard right now. Renderer-only, and empty
  while a modal, the PrimarySidebar, or the command palette holds focus.

Close, save, find, clear, restart, and the Status Bar resolve their target from real DOM focus
first and fall back to `activePaneId`. Without this, an asynchronous Terminal state change can steal
a command aimed at the Monaco pane the user is typing in.

## Scope and ownership

The whole layout is persisted per `(sessionId, workbenchProjectId)`, extending ADR 0001 rather than
carving out an exception for Terminals. Terminal processes and records stay Session-global; only
their **placement** becomes root-local, so switching the Workbench Root restores a different
arrangement without restarting anything. Every durable Terminal appears exactly once in each root's
snapshot, which makes Terminal creation, deletion, and Session moves transactional across snapshots
while an ordinary pane-to-pane move touches only the current one.

## View placement

The split tree owns geometry, while a flat set of pane portals owns mounted views. A visible
Terminal retains its pane portal by Terminal identity across Workbench Root changes and split-tree
placement. Other tab transitions retain the existing pane identity. The portal moves its existing
DOM host into the new layout slot; the entire pane, including its tab bar and event handlers,
remains inside one React ancestry. This preserves xterm, selection, scrollback, and search without
replaying the same live PTY just because a container changed.

The tab bar resets its local drag and exit-animation state when the logical pane ID changes;
Terminal content keeps its lifetime. The entire pane view is keyed by Session ID so local state
cannot cross Session boundaries even if persisted pane IDs happen to match.

Only the current layout's panes remain mounted. Switching a pane to a different resource still
unmounts the old content, and closing a pane or leaving a Session releases its views. This is not
a cache of hidden terminals. First visits to a Workbench Root persist their generated layout before
another bootstrap read, so pane and tab identities remain stable before the first user layout edit.

## Attachment lease

Hiding a Terminal tab and showing it again detaches one view and attaches another, and Host input
and resize bypass the ordered request queue. A late `detach` or a stale `ResizeObserver` from the old pane can
therefore land after the new pane attaches and either orphan the view or resize the PTY back to the
old geometry. `attach`, `input`, `resize`, `detach`, and `output` carry an attachment id; Runtime
keeps one current lease per Terminal, replaces it atomically, and makes every stale-lease message a
no-op. This lands before the panes merge, not after.

## Tab sizing

Terminal tabs are the high-frequency case: most Sessions open several, and a Terminal tab's title
is the only thing that tells two Agents apart, so they divide the bar's remaining width evenly
(`flex-1`, no maximum), shrinking to an 80px floor before the bar scrolls horizontally; fixed
actions sit outside the scrolling viewport. Document tabs size to their full label with a 50px
floor and no fixed ceiling, matching VS Code's default `tabSizing: fit` behavior. They do not shrink:
long filenames remain readable while Terminal tabs divide the remaining space, and a crowded rail
scrolls once Terminal tabs reach their floor. This replaces the former 160px cap, which abbreviated
filenames even beside a mostly empty Terminal tab. This is the one place a tab's kind reaches into layout;
pane placement, closing, and navigation still share the same tree operations. The Editor-to-Terminal
path-input gesture does not change that tree.

Each pane bar is its own `tablist` with its own roving tab index and its own `tabpanel`; several
panes legitimately have a selected tab at once. The macOS traffic-light inset and the window drag
region stay with a Workbench-level chrome surface instead of turning every pane's bar into a drag
handle.

## Migration

This breaks the wire contract: `SessionState` is shared by `app.bootstrap` and `session.updateState`,
so the protocol version, the session-state version, and the layout version all step forward together
and Host, Runtime, Preload, CLI, and fixtures upgrade atomically. Per the pre-public compatibility
policy there is no adapter and no dual read or write. A migration (since folded into `0000_baseline.sql`) drops
`session_state` down to its four surviving columns and hard-resets every row's `state_version` to `2`
and `workbench_state_json` to `{}`: it does not attempt to convert the old Terminal/Editor trees
into pane layouts, since Caxri has no public release yet and there is nothing to preserve worth the
conversion complexity. Each Workbench Root then rebuilds its layout the first time it is read after
upgrade: `defaultSessionPaneLayout` places every durable Terminal owned by the Session into
one pane, and any previously open Editor tabs are gone. Terminal identity, PTY state, and Session/
Project records are untouched: only pane placement resets. A layout is capped at 8 panes
(`MAX_PANE_LAYOUT_PANES`); its single-pane arrangement never approaches that limit.

## Command surface

The old mutually-exclusive trees exposed separate split commands per tree. The unified tree exposes
one family (`workbench.splitLeft` / `splitRight` / `splitUp` / `splitDown`) that splits whatever
pane is active regardless of what its tabs hold; `workbench.closeActiveTab`, `workbench.nextTab`, and
`workbench.previousTab` follow the same pattern (`apps/desktop/src/renderer/src/commands/definitions.ts`).

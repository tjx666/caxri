# One pane tree for Terminals and documents

- Status: accepted
- Date: 2026-08-21
- Refs: [#257](https://github.com/tjx666/caxri/issues/257)

The Workbench renders exactly one of two mutually exclusive split trees — Terminals or Editors —
behind a single global tab strip, so a running Agent and the file it is editing can never be visible
at the same time. Terminals and documents are equally first-class in Caxri, so the two trees merge
into one pane tree. Every pane owns its own tab bar, and a tab's kind decides what the pane renders
and, per [Tab sizing](#tab-sizing), how wide its own tab grows; splitting, drag and drop, closing,
and navigation never branch on it.

## Identity

Three layers, deliberately separated, because today's `WorkItem` collapses them into one id and that
is what forces every asymmetry:

- **Pane** — a leaf of the tree; owns a tab bar, an active tab, and a fraction of the surface.
- **Tab (occurrence)** — one appearance of a resource in one pane; owns ordering, selection, close,
  DOM identity, and motion.
- **Resource** — the thing being shown; owns the PTY process, the document model and its dirty
  buffer, and Monaco's language services.

`PaneResource` is a two-way union: `{ kind: 'file', path }` or `{ kind: 'terminal', terminalId }`.
Diffs and transcripts stay `file` resources named by a virtual URI scheme
(`caxri-git-diff://…`, `caxri-agent-transcript://…`, recognized by `isVirtualEditorTabPath`)
rather than becoming their own `PaneResource` kinds — they already behave like documents (openable,
closable, repeatable, never read or written through `files.*`), so a third and fourth kind would
duplicate the `file` branch everywhere without buying new behavior.

## Instance versus document

The one asymmetry that survives is a property of the resource, not of the layout:

- A Terminal is an **instance**. Its PTY exists once, so it appears in exactly one pane of a layout.
- A file, diff, or transcript is a **document**. It is `repeatable`: the same resource may occupy
  several panes at once, each occurrence with its own tab id, cursor, scroll, and reveal state,
  while content and dirty state stay shared.

Dragging always **moves** an occurrence, for every kind. Duplication is a separate, explicit command
(`Open in New Pane`) offered only by repeatable resources. The generic tree reducer therefore never
inspects a tab's kind; only the resource capability table does.

## Focus

Three pieces of state replace the single global active item:

- `pane.activeTabId` — what each pane shows. Persisted.
- `layout.activePaneId` — the last active pane, used to restore and as the fallback target.
  Persisted.
- `focusedPaneId` — the pane that actually owns the keyboard right now. Renderer-only, and empty
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

## Attachment lease

Moving a Terminal between panes detaches one view and attaches another, and Host input and resize
bypass the ordered request queue. A late `detach` or a stale `ResizeObserver` from the old pane can
therefore land after the new pane attaches and either orphan the view or resize the PTY back to the
old geometry. `attach`, `input`, `resize`, `detach`, and `output` carry an attachment id; Runtime
keeps one current lease per Terminal, replaces it atomically, and makes every stale-lease message a
no-op. This lands before the panes merge, not after.

## Tab sizing

Terminal tabs are the high-frequency case — most Sessions open several, and a Terminal tab's title
is the only thing that tells two Agents apart — so they divide the bar's remaining width evenly
(`flex-1`, no maximum), shrinking to an 80px floor before the bar scrolls horizontally; fixed
actions sit outside the scrolling viewport. Document tabs are opened far less often and rarely need
the title for disambiguation, so they size to their own content instead, bounded 50–160px — the same
floor and ceiling VS Code's `tabSizingFixed` uses. A pane can mix both kinds in one bar, and an
editor width cap that only applied once a Terminal tab joined the bar would be its own source of
surprise, so the bound is unconditional. This is the one place a tab's kind reaches into layout;
everywhere else — splitting, drag and drop, closing, navigation — still never branches on it.

Each pane bar is its own `tablist` with its own roving tab index and its own `tabpanel`; several
panes legitimately have a selected tab at once. The macOS traffic-light inset and the window drag
region stay with a Workbench-level chrome surface instead of turning every pane's bar into a drag
handle.

## Migration

This breaks the wire contract: `SessionState` is shared by `app.bootstrap` and `session.updateState`,
so the protocol version, the session-state version, and the layout version all step forward together
and Host, Runtime, Preload, CLI, and fixtures upgrade atomically. Per the pre-public compatibility
policy there is no adapter and no dual read or write. Migration `0012_unified_pane_layout.sql` drops
`session_state` down to its four surviving columns and hard-resets every row's `state_version` to `2`
and `workbench_state_json` to `{}` — it does not attempt to convert the old Terminal/Editor trees
into pane layouts, since Caxri has no public release yet and there is nothing to preserve worth the
conversion complexity. Each Workbench Root then rebuilds its layout the first time it is read after
upgrade: `SessionsModel.defaultPaneLayout` places every durable Terminal owned by the Session into
one pane, and any previously open Editor tabs are gone. Terminal identity, PTY state, and Session/
Project records are untouched — only pane placement resets. A layout is capped at 8 panes
(`MAX_PANE_LAYOUT_PANES`); `defaultPaneLayout`'s single-pane arrangement never approaches that limit.

## Command surface

The old mutually-exclusive trees exposed separate split commands per tree. The unified tree exposes
one family — `workbench.splitLeft` / `splitRight` / `splitUp` / `splitDown` — that splits whatever
pane is active regardless of what its tabs hold; `workbench.closeActiveTab`, `workbench.nextTab`, and
`workbench.previousTab` follow the same pattern (`src/renderer/src/commands/definitions.ts`).

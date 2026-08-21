# One pane tree for Terminals and documents

- Status: proposed
- Date: 2026-08-21
- Refs: [#257](https://github.com/tjx666/caxri/issues/257)

The Workbench renders exactly one of two mutually exclusive split trees — Terminals or Editors —
behind a single global tab strip, so a running Agent and the file it is editing can never be visible
at the same time. Terminals and documents are equally first-class in Caxri, so the two trees merge
into one pane tree. Every pane owns its own tab bar, and a tab's kind decides only what the pane
renders: layout, splitting, drag and drop, closing, and navigation never branch on it.

## Identity

Three layers, deliberately separated, because today's `WorkItem` collapses them into one id and that
is what forces every asymmetry:

- **Pane** — a leaf of the tree; owns a tab bar, an active tab, and a fraction of the surface.
- **Tab (occurrence)** — one appearance of a resource in one pane; owns ordering, selection, close,
  DOM identity, and motion.
- **Resource** — the thing being shown; owns the PTY process, the document model and its dirty
  buffer, and Monaco's language services.

`file`, `diff`, `transcript`, and `terminal` are modeled explicitly. Diffs and transcripts stop
masquerading as Editor paths.

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
  while a modal, the Sidebar, or the command palette holds focus.

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

Tabs divide their own bar equally with **no maximum width**, shrinking to roughly 80px before the
bar scrolls horizontally; fixed actions sit outside the scrolling viewport. VS Code caps tabs at
160px because it is an editor-first product where a pane holds many files. Caxri is terminal-first —
most Sessions never open an editor at all — and a Terminal tab's title is the only thing that tells
two Agents apart, so the room goes to the title.

Each pane bar is its own `tablist` with its own roving tab index and its own `tabpanel`; several
panes legitimately have a selected tab at once. The macOS traffic-light inset and the window drag
region stay with a Workbench-level chrome surface instead of turning every pane's bar into a drag
handle.

## Migration

This breaks the wire contract: `SessionState` is shared by `app.bootstrap` and `session.updateState`,
so the protocol version, the session-state version, and the layout version all step forward together
and Host, Runtime, Preload, CLI, and fixtures upgrade atomically. Per the pre-public compatibility
policy there is no adapter and no dual read or write. The SQLite migration converts both old trees
per root inside one transaction, joins them with a deterministic split when both exist, derives
Terminal tab ids from their Terminal id, and fails closed to a single pane holding every durable
Terminal when the stored state is unusable. The first release caps a layout at 8 panes; a migrated
tree over that keeps every tab and collapses the excess topology rather than dropping work.

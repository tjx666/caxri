---
kind: living
status: current
---

# Open Sessions

A Desktop window keeps a working set of Sessions in a tab strip above the Workbench. Each entry is an
**Open Session** (see [GLOSSARY.md](../GLOSSARY.md)); the window shows exactly one at a time. The
decision behind the model is [ADR 0017](adr/0017-per-window-session-presence.md).

## The tab strip

- The strip appears only when a window has two or more Open Sessions. With one, the window looks as it
  always did and the pane tab bar stays the title bar. When the strip is shown it takes the drag
  region, the traffic-light inset, and the title-bar fill.
- The active tab carries a 2px accent top border; the pane tabs below use a plain fill, so one accent
  shows per screen. Each tab shows the Session's status indicator and title and reads that Session's
  own state by ID. A crowded strip scrolls instead of shrinking tabs below a minimum width.
- Plain click on a Session row selects it. That **replaces the active entry** when the Session is not
  already open (like navigating inside a browser tab), or activates it when it already is, so browsing
  the sidebar never grows the strip. Only an explicit open adds a tab: Cmd+click, **Open in New Tab** in
  the Session row menu, and the strip's trailing **+** button (a new Session in the active Session's
  Project, started like Cmd+N, with `placement: 'newTab'`). Every other creation path (Cmd+N,
  the sidebar's New Session, moving a Terminal into a new Session, side-chat conversion) behaves like
  a plain select: it activates the Session, replacing the active entry, or becoming the only entry
  of an empty list.
- The **+** sticks to the right edge of the tab rail, so it stays reachable when tabs overflow. The
  strip's empty area to the right of it remains a window drag region. A Session with no tabs in its
  Workbench shows no pane tab bar under the strip, only the empty state.
- Tabs reorder by drag. Closing a tab never archives the Session; it only leaves the working set.
  Closing the active tab activates its neighbor, then another Session of the same Project, then none.
- A full strip (100 entries) drops its oldest non-active entry rather than refusing the Session the
  user just asked for.

## Shortcuts

| Shortcut       | Action                                                               |
| -------------- | -------------------------------------------------------------------- |
| Cmd+1 to Cmd+8 | Switch to the Nth Open Session                                       |
| Cmd+9          | Switch to the last Open Session (the browser convention)             |
| Cmd+Alt+1/2/3  | Show the Files, Git, and Status sidebar views (moved from Cmd+1/2/3) |

The meaning is stable: Cmd+1 to Cmd+9 always address Open Sessions, whether or not the strip is
visible. Cmd+0 is unchanged. Existing user keybinding files receive the move through
`defaultKeybindingChanges`; see [keybindings.md](keybindings.md). The switch commands work from an
editable surface too.

## Persistence

The strip is saved on the Server (not in Renderer storage, which same-origin windows share), keyed by
window key, and restored with the window after a restart. It is a working set only: archiving,
deleting, or hiding a Session or Project removes its IDs from every strip, and readers filter unknown
or archived IDs again, so a stale entry can never resurrect a Session. Selection changes and list
edits are separate writes; the list carries no active ID, so a late list save cannot undo a newer
selection.

## Windows

A Session is an Open Session of **at most one window**. The Server enforces this at entry level (membership in
a strip), in the two places a Session enters a strip: selecting it, and saving a strip.

- Selecting or resuming a Session that another window owns leaves the requesting window unchanged and
  activates the Session in its owner. The result carries `ownerWindowKey`, and Desktop Main raises the owner
  window (a notification click does the same). A strip edit that names a Session owned elsewhere drops it.
- Dragging a tab out of every window **tears it off**. Releasing the tab with no drop target (`dropEffect`
  `none`) outside the source window asks Main to open a new Workbench window; releasing it over the source
  window (a cancelled drag) or over another Workbench window opens nothing. The new window opens with its
  title bar under the cursor, keeps the source window's size, and is clamped to the display. The Renderer
  sends the `dragend` screen point, and Main falls back to the native cursor when the platform reports
  `0,0` (a known Chromium quirk VS Code works around the same way).
- A tear-off is all or nothing. Main creates the window hidden, the Server moves the Session in one
  transaction (`window.openSessions.moveToWindow`), and only then does the window show. A refusal (the source
  would be left empty, the Session is not open there) destroys the hidden window and changes nothing. A
  window's last Open Session cannot be torn off; the strip is hidden at one tab, so no drag starts.
- Closing a torn-off window releases its strip like closing its tab: its unsaved Editor buffers are decided
  for that window only, nothing touches Terminals, and the Session returns to the sidebar's pool and can be
  opened anywhere. Closing the primary window decides unsaved buffers for every window, then closes the
  torn-off windows but keeps their strips. Quitting keeps every strip too; the next launch reopens the
  torn-off windows, cascaded from the primary window (per-window bounds are not persisted yet).
- Event routing: shared state (Server state, Terminal output, settings) reaches every window; one-shot
  commands (menu accelerators, Editor open requests, toasts) reach only the focused window; an unsaved-Editor
  question or a window's own full-screen state reaches only its window. The table is `EVENT_AUDIENCE` in
  `apps/desktop/src/main/workbench-windows/event-audience.ts` and is exhaustive over server events.

Known limits: `desktop.openRequested` goes to the focused window, not necessarily a Session's owner; Terminal
output is broadcast to every window (each ignores Terminals it does not render); a tear-off window has no
Terminal prompts on close.

## Presence

Presence answers "what is each window looking at right now". It is memory only, lives on the Server
keyed by `(connection, window key)`, and is written exclusively by Desktop Main from native window state
plus the Session the Renderer reports it is viewing.

- **Visible** is the union of the viewed Session over all visible (not hidden, not minimized) windows.
  Background work follows it: the file watcher (primary visible Session), Status polling (every visible
  Session), and Agent suspension ([agent-suspension.md](agent-suspension.md)).
- **Current** is the focused window's Session, else the most recently focused window's. The CLI
  `current` selector, extension context, and mobile panel checks use it. A CLI call with no window
  does not select anything.
- A reconnect or Server restart starts with no presence. Main reseeds all live windows, with their
  focus order, as one snapshot before the connection serves a Renderer request. Until then (up to 30
  seconds) the Server treats the empty state as unknown, so no Terminal suspends on the gap. A
  connection loss drops that connection's windows.
- SSH Host windows keep their own connection and follow the same rules there.
- Notification suppression is separate: a Session counts as shown only if a focused, visible,
  non-minimized window renders it, re-checked right before display, with no recent-focus fallback.
  See [notifications.md](notifications.md).

## Performance and state isolation

Presence reports are a map write and one pass over a few rows, and listeners fire only when the derived
set really changes. In the Renderer the Open Session store is read through narrow selectors, so a tab
switch or reorder re-renders the strip and the incoming and outgoing Workbench, not every retained
one. Each Session's Workbench state stays keyed by Session ID, and panes use their owning Session's
context, never a global selection. Keep-alive stays the most recent five Sessions
([renderer-performance.md](renderer-performance.md)); Open Sessions are not pinned.

## Limits

Dropping a tab onto another window to merge it is not supported; a tear-off is one-way into a new window. The
file watcher is single-scope and follows the primary visible Session, so a Session shown only in a torn-off
window is watched while that window is the primary visible one. Per-window bounds are not persisted.

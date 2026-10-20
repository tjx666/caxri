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
  the sidebar never grows the strip. Cmd+click, or **Open in New Tab** in the Session row menu, opens
  it as an additional tab. Creating a Session and moving a Terminal into a new Session also append.
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

One window exists today; moving a Session into its own window is future work. The file watcher is
single-scope and follows the primary visible Session until then.

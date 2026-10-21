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
- The Session level is neutral: an inset 28px pill on the 36px title bar, with a raised fill on the active
  tab and no accent. The accent stays with the focused pane's active tab in the 36px pane row below
  (see DESIGN.md "Two tab levels"). Each tab shows the Session's status indicator and title and reads
  that Session's own state by ID. Tabs are 104px to 200px wide and the active tab never drops below
  150px; a crowded strip scrolls instead of shrinking them further.
- Every Open Session is either **kept** or the window's one **Preview entry** (the VS Code preview-editor
  model). A plain click on a Session row selects it: an already open Session is only activated;
  otherwise the click **replaces the Preview entry in place**, or, when the window has none, adds the
  Session right of the active tab as the new Preview entry. A kept entry is never replaced by plain
  navigation, so browsing the sidebar cannot make a tab you chose disappear, and the strip grows only
  by kept tabs plus at most one Preview tab. The Preview tab's title is italic (muted while inactive) and
  announces itself to screen readers.
- A Preview entry becomes kept on a double-click of its tab, **Keep Open** in the tab menu, Cmd+click on
  its row or **Open in New Tab**, dragging the tab, or any interaction inside the Session (typing,
  pasting, or a primary-button press anywhere in its Workbench; shortcuts such as `Cmd+1` do not count).
  A Session stays kept until its tab is closed.
- Only an explicit open adds a kept tab: Cmd+click, **Open in New Tab** in the Session row menu, the
  strip's trailing **+** button (a new Session in the active Session's Project, started like Cmd+N, with
  `placement: 'newTab'`), and moving a Terminal into a new Session. A new tab is **inserted immediately
  right of the active tab** (the browser and VS Code rule), not appended, so it lands next to where you
  were working; the Server applies the same rule to the strip's **+** (`activateSessionInWindow`) and the
  Renderer to the other two (`insertOpenSessionAfter`). With no active tab it appends. Cmd+N, the
  sidebar's New Session, and side-chat conversion behave like a plain click on the new Session: it
  becomes or replaces the Preview entry, and typing in it keeps it. A window with one kept tab therefore
  grows a second (Preview) tab on the first sidebar click, which is also when the strip appears.
- The Preview entry is persisted with the strip (`previewSessionId`, written only while one exists), so a
  restart restores it. Server edits that save a strip keep it while it is still listed and never create
  one; tearing the Preview tab off keeps it in the new window as a kept tab.
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
| Cmd+Shift+W    | Close Open Session: remove the active tab from the strip             |

The meaning is stable: Cmd+1 to Cmd+9 always address Open Sessions, whether or not the strip is
visible. Cmd+0 is unchanged. Existing user keybinding files receive the move through
`defaultKeybindingChanges`; see [keybindings.md](keybindings.md). The switch commands work from an
editable surface too.

Cmd+W and Cmd+Shift+W close at different levels, and neither archives. Cmd+W closes the active pane
tab; closing a Session's last pane tab (a Terminal included) leaves the Session open with the empty
Workbench state, so a keystroke never ends or hides a long-running Session. Cmd+Shift+W (command
`session.closeTab`, also in the tab context menu and the Command Palette) removes the active Session
from the strip and leaves it in the sidebar; with a single entry it does nothing, because the window
keeps at least one. Archiving is always an explicit action (Session menu, sidebar row menu). The
chord does not collide with window closing: the native menu has no Close Window item and the window
closes through its traffic light. Closing a Terminal tab runs the ordinary `terminal.close` path, so
Terminal resume and suspension are untouched.

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
- **Move to New Window** is the non-drag path to the same tear-off, for keyboard and pointer-only use: the Session tab
  context menu, the sidebar row menu (only for a Session in this window's strip), and the Command Palette command
  `session.moveToNewWindow` (acts on the active Session). It sends `window.tearOffSession` with
  `placement: 'cascade'`: there is no release point and the cursor is over the source window, so Main skips the
  "released over a window" refusals and opens the window cascaded 30px per other window from the source, at its
  size, clamped to the display. It is disabled with a single entry, like the drag.
- While a tab drag is in progress the strip stays visible even if its membership fell below two (a Session pruned
  mid-drag), so the title bar does not jump under the pointer and the drag source is not removed.
- A tear-off is all or nothing. Main creates the window hidden, the Server moves the Session in one
  transaction (`window.openSessions.moveToWindow`), and only then does the window show. A refusal (the source
  would be left empty, the Session is not open there) destroys the hidden window and changes nothing. A
  window's last Open Session cannot be torn off; the strip is hidden at one tab, so no drag starts, and the menu
  entries are disabled or absent.
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

## Linking the strip and the sidebar

The strip keeps its own order (the user's, never the sidebar's activity order), so three cues connect the
two surfaces instead of mirroring one in the other:

- **Open markers.** A sidebar row for a Session open in this window shows a 2px neutral edge bar (never
  the accent), only while the strip is visible. A Session another window owns shows a small window glyph
  after its title; clicking it brings that window forward. The Server supplies the second set as
  `bootstrap.otherWindowOpenSessionIds` (disjoint from `openSessionIds`), and a strip edit that changes
  membership re-reads the other windows' Workbench. Each row selects its own marker as a primitive
  (`useSessionOpenPlace`), so a strip edit re-renders only the rows that flipped.
- **Reveal.** Every activation (sidebar click, tab click, Cmd+N, MRU, history, notification) expands the
  Session's Project and scrolls its row into view (`useSelectedSessionReveal`). The tab context menu's
  **Reveal in Sidebar** does the same on demand for any tab: it opens a hidden Primary Side Bar, leaves the
  Activity view, widens a Project's `Show N more` window or the Pinned group down to the row, then scrolls.
- **Hover link.** Hovering a tab softly highlights its sidebar row, and hovering a row highlights its tab
  (`linked-session-hover.ts`). Both sides select a boolean for their own Session from one small store.

## Tab and row labels

The strip and the PrimarySidebar name a Session through one pure rule
(`features/session/session-labels.ts`), so they never disagree. The title chain is the stored title
(the user's rename or the Agent's), then a snippet of the first prompt (24 characters), then
`Project · worktree`, then the translated "Untitled". The prompt snippet is an optional input that no
surface supplies yet.

A muted suffix follows the title only when another non-archived Session carries the same
(case-insensitive) title, and it escalates only as far as needed: the Project name when the colliding
Sessions belong to different Projects; else the Agent kind and linked worktree when those differ; else a
per-Project ordinal such as `#2`. The ordinal is the rank by creation time among every Session of that
Project with that title, archived or not, so closing, archiving, or reordering a sibling never
renumbers the rest. The suffix is computed over the whole snapshot rather than the strip alone, which
keeps a tab and its sidebar row identical.

A tab's tooltip lists the full label, Project, Agent, worktree, status, and the `Cmd+N` chord that
selects it. The record carries no branch name, so the worktree stands in for it.

---
kind: living
status: current
---

# Open Sessions

A Desktop window shows one Session at a time, and that Session is the window's **Open Session** (see
[GLOSSARY.md](../GLOSSARY.md)). There is no Session tab strip: the PrimarySidebar is the only Session
switcher, and a second window is the way to see two Sessions at once. The decision behind the model is
[ADR 0017](adr/0017-per-window-session-presence.md) and its 2026-10-22 amendment.

## One row of navigation

- The Workbench has one horizontal tab level: the pane tab bar, which doubles as the window's title bar
  (traffic-light inset, drag region, title-bar fill). Switching Sessions never adds or removes a row, so
  the content below never jumps.
- Selecting a Session from any surface (sidebar click, Cmd+click, Cmd+N, MRU switcher, history,
  notification) replaces the window's Open Session. The Server writes the window's cell as exactly
  `[sessionId]` (`activateSessionInWindow`), so a window never accumulates a hidden working set that
  would keep claiming Sessions another window wants.
- The selected sidebar row's fill glides from the previous row to the new one over
  `--motion-chrome-switch` (160ms) while the Workbench content switches instantly; see DESIGN.md.
  Every activation also expands the Session's Project and scrolls its row into view
  (`useSelectedSessionReveal`).

## Shortcuts

| Shortcut       | Action                                                               |
| -------------- | -------------------------------------------------------------------- |
| Cmd+1 to Cmd+8 | Switch to the Nth Session in the Pinned group                        |
| Cmd+9          | Switch to the last Pinned Session (the browser convention)           |
| Cmd+Alt+1/2/3  | Show the Files, Git, and Status sidebar views (moved from Cmd+1/2/3) |

The commands are `session.openPinned1` to `session.openPinned9`, follow the Pinned group's current
order, and work from an editable surface too. A position past the end does nothing. Holding the
modifier alone for 400ms replaces each Pinned row's status glyph with its live chord (`⌘1`), the way a
browser reveals tab numbers; the badge follows the user's binding and appears only for a single-chord
binding whose modifiers are exactly the held ones.

Existing keybinding files are migrated through `defaultKeybindingChanges`: the former
`session.openTab1..9` entries are replaced in place with the Pinned commands on the same chords, and
the removed Close Open Session default (`cmd+shift+w`, `session.closeTab`) is deleted. A user's own
binding for a removed command is left alone. See [keybindings.md](keybindings.md).

Cmd+W closes the active pane tab; closing a Session's last pane tab (a Terminal included) leaves the
Session open with the empty Workbench state, so a keystroke never ends or hides a long-running Session.
Archiving is always an explicit action.

## Reopening closed tabs and Sessions

`Cmd+Shift+T` (**Reopen Closed Editor or Session**) reopens the most recently closed thing and walks
further back on each press, the way a browser and VS Code do. The history lives in Renderer memory
only (30 entries, most recent first, `features/closed-items/`) and is not restored after a restart.

- A closed editor tab is remembered with its Session, pane, and tab index. It reopens in that pane at
  that position when the pane still exists, otherwise in the active pane, switching to its Session
  first, and a text editor takes focus. External documents keep their content in the entry because
  closing them evicts the only copy. Terminal tabs are never recorded (closing one ends its PTY), and
  neither are untitled editor tabs (their content is discarded on close).
- "Closing a Session" means archiving it. Reopening restores the archived Session to the row it was
  archived from and selects it; its closed tabs sit behind it in the history. Deleting a Session
  removes its entries instead, because deletion is irreversible.
- An entry that cannot reopen (Session deleted or archived by someone else, file deleted, tab already
  open) is discarded and the press continues to the next entry.

## Persistence

The window's Open Session is saved on the Server (not in Renderer storage, which same-origin windows
share), keyed by window key, and restored with the window after a restart. It never decides whether a
Session exists: archiving, deleting, or hiding a Session or Project reconciles every window, moving one
whose Session went away to a fallback Session no other window holds.

## Windows

A Session is the Open Session of **at most one window**.

- Selecting or resuming a Session another window shows leaves the requesting window unchanged and
  activates the Session in its owner. The result carries `ownerWindowKey`, and Desktop Main raises the
  owner window (a notification click does the same). The sidebar marks such a row with a small window
  glyph after its title (`bootstrap.otherWindowOpenSessionIds`).
- **Open in New Window** in a sidebar row's menu opens that Session in a new Workbench window. The entry
  is absent for the Session this window shows (the window would be left empty) and for a Session another
  window already shows (selecting it brings that window forward). It sends `window.tearOffSession`
  with only `{ sessionId }`; Main opens the window cascaded 30px per other window from the source, at
  its size, clamped to the display.
- The move is all or nothing. Main creates the window hidden, the Server moves the Session in one
  transaction (`window.openSessions.moveToWindow`, refusals `shown_session`, `open_elsewhere`, and
  `target_in_use`), and only then does the window show. A refusal destroys the hidden window and changes
  nothing.
- Closing a secondary window releases its Session: its unsaved Editor buffers are decided for that window
  only, nothing touches Terminals, and the Session can be opened anywhere again. Closing the primary
  window decides unsaved buffers for every window, then closes the others but keeps their cells. Quitting
  keeps every cell too; the next launch reopens the secondary windows, cascaded from the primary window
  (per-window bounds are not persisted yet).
- Event routing: shared state (Server state, Terminal output, settings) reaches every window; one-shot
  commands (menu accelerators, Editor open requests, toasts) reach only the focused window; an
  unsaved-Editor question or a window's own full-screen state reaches only its window. The table is
  `EVENT_AUDIENCE` in `apps/desktop/src/main/workbench-windows/event-audience.ts` and is exhaustive over
  server events.

Known limits: `desktop.openRequested` goes to the focused window, not necessarily a Session's owner;
Terminal output is broadcast to every window (each ignores Terminals it does not render); a secondary
window has no Terminal prompts on close; a Session cannot be moved back into an existing window.

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
set really changes. Each Session's Workbench state stays keyed by Session ID, and panes use their owning
Session's context, never a global selection. Keep-alive stays the most recent five Sessions
([renderer-performance.md](renderer-performance.md)), so switching back to a recent Session is instant.
Each sidebar row selects its own "open in another window" marker as a primitive
(`useIsSessionOpenElsewhere`), so a window change re-renders only the rows that flipped.

## Row labels

The PrimarySidebar and pickers name a Session through one pure rule
(`features/session/session-labels.ts`). The title chain is the stored title (the user's rename or the
Agent's), then a snippet of the first prompt (24 characters), then `Project · worktree`, then the
translated "Untitled". The prompt snippet is an optional input that no surface supplies yet.

A muted suffix follows the title only when another non-archived Session carries the same
(case-insensitive) title, and it escalates only as far as needed: the Project name when the colliding
Sessions belong to different Projects; else the Agent kind and linked worktree when those differ; else a
per-Project ordinal such as `#2`. The ordinal is the rank by creation time among every Session of that
Project with that title, archived or not, so archiving or reordering a sibling never renumbers the rest.

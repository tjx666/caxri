---
kind: adr
status: accepted
---

# Per-window Session presence and Open Sessions

- Date: 2026-10-21
- Amends: [ADR 0005](./0005-multi-client-state-ownership.md)
- Amended by: [ADR 0019](./0019-extension-view-request-scope.md) (extension views and mobile panels use their request's Session, not Current)

[ADR 0005](./0005-multi-client-state-ownership.md) gave a Server one "selected Session" and treated a
Connection's focus as transient. That cannot describe a Desktop with a Session tab strip, or later two
windows, because one Desktop Main shares a single lease and connection across all its windows. A Server
now tracks two things per Desktop window, keyed `(Connection ID, window key)`:

- **Open Sessions**: the window's ordered strip of Sessions and which one is active. This is persisted
  on the Server (one `app_state` cell keyed by window key, so it needs no SQL migration) and is a working
  set, never a source of truth for existence: archive, delete, and hide drop IDs from every strip, and
  readers filter unknown IDs again.
  Only an explicit open adds a kept entry (Cmd+click, **Open in New Tab**, the strip's **+** through
  `session.create` with `placement: 'newTab'`, and moving a Terminal into a new Session). Selecting and creating
  a Session activate an open entry, replace the window's one **Preview entry**, or become it, so plain navigation
  never grows the set of kept tabs. The Preview entry (`previewSessionId` in the same cell) is promoted by
  `window.openSessions.keep`; see [open-sessions.md](../open-sessions.md).
- **Presence**: which Session the window renders, plus its native focus and visibility. This is memory
  only. Desktop Main is the only writer; it supplies focus, visibility, and minimize state from the native
  window, and the Renderer contributes only the viewed Session. Main mints the window key, injects it from
  the trusted `event.sender`, and overwrites any key a Renderer sends.

Two derived values replace the single selection. **Visible** is the union of the viewed Session over
visible windows; work that serves a human looking at the screen (file watching, Status polling, Terminal
suspension) keys off it. **Current** is the focused window's Session, else the most recently focused
window's; anything asking "which Session is the user in" (the CLI `current` selector, extension context,
mobile panel checks, notification suppression inputs) keys off it. A caller with no window, such as the
CLI, gets no per-window effect.

The active Session changes only through `session.select` tagged with the window key. The ordered list is
written by `window.openSessions.set`, which carries no active ID, so a debounced list save can never
overwrite a newer selection.

## Considered Options

- **Persist presence.** Rejected: a restarted Server would act on windows that may be gone. Presence
  starts empty and Main reseeds every live window as one atomic snapshot while it re-attaches, before the
  connection serves any Renderer request. Until the first report (or a 30 second grace), the Server treats
  "nothing reported" as unknown and skips Terminal suspension sweeps, so the gap is not read as every
  window being hidden.
- **Keep the "selected Session" cell and add a per-window override.** Rejected: two sources of truth for
  the same fact, and the legacy cell cannot express a union.
- **Store the strip in Renderer `localStorage`.** Rejected: it is shared across same-origin windows and
  invisible to the Server, which must prune IDs when a Session is archived or deleted.
- **Pin every Open Session in Renderer keep-alive.** Rejected: a long strip would hold unlimited mounted
  Workbenches. The keep-alive limit stays an MRU cap.

## Consequences

Every Server consumer of "selected Session" moved to Visible or Current, and the file watcher still
follows a single primary visible Session until multi-watcher support lands with tear-off windows. SSH
Host windows keep their own connection, so each injects its own window key, reports presence, and
reseeds on reconnect. Notification suppression reads Main's live native window state (focused, visible,
not minimized), never the most-recently-focused fallback. Behavior is documented in
[Open Sessions](../open-sessions.md).

## Amendment: tear-off windows (2026-10-21)

Tear-off windows land the second window this ADR anticipated. The decisions:

- **A Session is an Open Session of at most one window.** Checked at entry level in the Server's two strip
  write paths. A select or resume of a Session owned elsewhere activates it in the owner and returns
  `ownerWindowKey`; a strip save drops entries owned elsewhere; reconcile de-duplicates across windows,
  keeping the first window in key order with `main` first. This matches Termany's one page per window claim
  and cmux's `moveWorkspaceToWindow`, and avoids two windows driving one Session's Terminals and resize lease.
- **Main mints window keys** (`win-<uuid>`, matching `windowKeySchema`); `main` stays the primary key. A
  Renderer never names a window key or bounds, it asks `window.tearOffSession { sessionId, screenPoint? }`.
- **Transfer is one Server transaction** (`window.openSessions.moveToWindow`, Main-only, refusals
  `last_tab`, `not_open`, `target_in_use`), and Main shows the new window only after it succeeds, so a failed
  tear-off never leaves a Session in zero or two windows.
- **Window lifetime follows strips.** Closing a tear-off releases its strip; closing the primary window or
  quitting keeps strips so the windows restore at launch.

The file watcher stays single-scope. Behavior is documented in [Open Sessions](../open-sessions.md).

## Amendment: one Open Session per window (2026-10-22)

The Session tab strip is removed. A window's Open Sessions are now exactly the Session it shows, and the
decisions above that describe a kept working set, the Preview entry, `window.openSessions.keep` and `set`,
and drag tear-off no longer apply.

- **Why.** Two stacked 36px rows made the content jump whenever the strip appeared, and a Session's title
  showed three times (sidebar row, Session tab, pane tab). The PrimarySidebar already lists every Session,
  so a second switcher in the title bar duplicated it. VS Code likewise keeps one tab row per window and uses windows, not tabs, to show a second workspace.
- **Selection replaces.** `activateSessionInWindow` writes `[sessionId]`. Keeping a hidden working set would
  have kept claiming Sessions under the one-window rule while nothing on screen showed them.
- **Ownership stays.** A Session is still the Open Session of at most one window, and selecting it elsewhere
  still raises its owner.
- **A second window replaces a second tab.** The sidebar row's **Open in New Window** sends
  `window.tearOffSession { sessionId }`; Main always cascades the new window. The move refuses
  `shown_session` (the source would be empty), `open_elsewhere`, and `target_in_use`.
- **Shortcuts move to Pinned.** `Cmd+1` to `Cmd+8` switch to the Nth Pinned Session and `Cmd+9` to the last, the only stable
  ordering the sidebar offers. Existing keybinding files migrate in place, and the removed Close Open Session
  default is deleted through a new `remove` default-keybinding change.

Behavior is documented in [Open Sessions](../open-sessions.md).

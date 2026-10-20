---
kind: adr
status: accepted
---

# Per-window Session presence and Open Sessions

- Date: 2026-10-21
- Amends: [ADR 0005](./0005-multi-client-state-ownership.md)

[ADR 0005](./0005-multi-client-state-ownership.md) gave a Server one "selected Session" and treated a
Connection's focus as transient. That cannot describe a Desktop with a Session tab strip, or later two
windows, because one Desktop Main shares a single lease and connection across all its windows. A Server
now tracks two things per Desktop window, keyed `(Connection ID, window key)`:

- **Open Sessions**: the window's ordered strip of Sessions and which one is active. This is persisted
  on the Server (one `app_state` cell keyed by window key, so it needs no SQL migration) and is a working
  set, never a source of truth for existence: archive, delete, and hide drop IDs from every strip, and
  readers filter unknown IDs again.
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

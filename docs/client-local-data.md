---
kind: living
status: current
---

# Client-local data

Caxri is server-first: Server Core owns Projects, Sessions, Terminals, Agents, and their SQLite
state, and every client reads it over the protocol. That Server is not always on the client's
machine. An SSH Host window talks to a Server on another computer
([ADR 0014](adr/0014-ssh-remote-server.md)), and the phone always talks to a computer elsewhere. So a
client keeps a small amount of data on its own device, for two reasons only:

1. **Input that cannot be rebuilt.** Text the user typed but has not sent or saved exists nowhere
   else. Losing it to a crash, a reload, or the system ending a backgrounded app is data loss.
2. **Reading while the Server is out of reach.** A saved copy of what the user last read beats a
   spinner, as long as it is labeled and never acted on.

Everything else stays on the Server. A client never edits from a saved copy, never queues
mutations to replay later, and never merges a saved copy into live state.

## The device store

`packages/protocol/src/device-store` is the one client-side persistence engine, shared by the phone
and the Desktop Renderer because protocol is the only package both may import. Each client plugs
in its own backend: files in the app's private document directory on the phone, an IndexedDB
database in the Renderer profile on Desktop.

- **Scoped.** Every entry records the identity it was written under: a pairing (host, device,
  generation) on the phone, an environment (`local` or `ssh:<host identity>`) on Desktop. An entry
  from another scope or another format version reads as a miss, and a write whose scope stopped
  being current before it flushed is dropped.
- **Debounced.** A save trails the change by a delay (one second for every current user), so a
  stream of edits costs one write per pause. Clients flush pending writes when the app or window
  goes to the background or unloads, where timers may never run again.
- **Ordered.** Writes, removals, and `clear` land in call order even on an asynchronous backend, and
  `clear` drops every write scheduled before it, so forgotten content never comes back.
- **Bounded.** A retention rule keeps the newest entries of a family and evicts the oldest.
- **Best effort.** Every read or write failure is a miss. A broken entry never blocks the live view
  or an edit; at worst the copy is lost.

## What each client keeps

| Client  | Data                                     | Bound                                       | Cleared when                                                     |
| ------- | ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| Phone   | Saved Session list, Conversations, Chats | 50 items each, 20 Conversations and Chats   | Forgetting the computer, a revoked device, or a new pairing      |
| Phone   | Unsent composer drafts                   | 50 drafts, 1,000,000 characters             | Same as above; a sent or cleared draft is removed                |
| Desktop | Unsaved Editor buffers (hot exit)        | 50 buffers per environment                  | Save, revert, close without saving, Session deletion, Don't Save |
| Desktop | Recent files for `Cmd+P`                 | 200 paths per Workbench Root                | Never cleared; a file that no longer opens is dropped            |
| Desktop | Agent Chat drafts and attachments        | Owned by `agent-chat-drafts.ts` and its IDB | Their own rules; not yet on the device store                     |

The phone's read cache and drafts are described in [mobile design](mobile/design.md#read-cache).

### Desktop Editor hot exit

`apps/desktop/src/renderer/src/features/editor/editor-backups.ts` follows the session-view store,
as VS Code's hot exit follows dirty working copies. Each unsaved, writable, non-virtual buffer is
backed up about one second after typing pauses, with the disk modification time and size it was
edited from. The backup is removed once the buffer stops being unsaved: saved, reverted, closed
without saving, renamed away, or its Session deleted. After the user chooses Don't Save on quit or
window close, Main sends `editor.unsavedRequest` with `discardAll`, and the Renderer drops those
backups before answering, so they do not return on the next launch.

Untitled buffers (`caxri-untitled://N`, opened with `Cmd+Alt+N`) are backed up the same way with a
zero modification time and size, since they have no file. At the next launch a backup recreates its
buffer only while the Session layout still holds the untitled tab; otherwise it stays until eviction.

A backup from an earlier launch is applied when its document is read from disk again (opening the
tab, or the active tab loading at startup):

- **File unchanged since the backup's base** (same modification time and size): the buffer comes
  back as unsaved over it, exactly as the user left it.
- **File changed while Caxri was closed**: disk wins, as it does for a live buffer
  ([ADR 0013](adr/0013-editable-external-documents.md)), and the warning notice offers
  "Restore My Changes" with the backup's text. The backup stays until the restored buffer replaces
  it or eviction drops it, so quitting before choosing still loses nothing.
- **Same text on disk** (the save landed but its backup removal did not), or a now read-only file:
  the backup is dropped silently.

A backup whose document is never opened again stays until eviction. Backups never leave the device
that typed them, never enter Server Core, and never appear in logs or diagnostics. Each environment
has its own database, so an SSH Host window never restores a local buffer and two hosts never see
each other's text. Workbench windows of one environment, tear-off windows included, share its
database, so a backup is restored by whichever window next reads its document.

### Desktop recent files

`Cmd+P` lists recently opened files under "Recently opened", as VS Code's Quick Open lists its editor
history. `apps/desktop/src/renderer/src/features/editor/recent-files.ts` is the pure model and
`recent-files-store.ts` its storage. Every Project file that opens as an editor tab (Files tree, path
browser, Terminal links, `caxri open`) moves to the front of its Workbench Root's list, which holds
200 absolute paths per environment and Workbench Root (VS Code keeps 200 per workspace). It lives in
Renderer `localStorage` rather than the device store: it is rebuildable view state, not input that
cannot be recovered, and the dialog reads it synchronously.

A row reopens through `openFileForSession`, the same Server Core-authorized `files.read` a Files-tree
click uses, so a stored path grants nothing: the Renderer cannot read or write a path outside the
Session's Project root through it. A file that no longer opens leaves the list and the history.
External documents are never recorded: their authority is a process-lifetime Main `documentId`
([ADR 0013](adr/0013-editable-external-documents.md)) that cannot be reopened after a restart. With
an empty filter the list shows every recent file except the one in the active tab; with a bare
filter it keeps the names that match (prefix, then substring, then in-order letters), ranked above
the directory and Project-wide results, which omit files already listed. A typed path
(`src/`, `/`, `~`) shows no recent files.

### SSH Host disconnect

While an attached SSH Host window reconnects, its Workbench stays on screen and readable, made
`inert` so nothing is sent to a Server that cannot answer, and the connection card floats above it
with Retry, Reconnect, and Close Window. Before the first attach the card still fills the window,
since there is nothing to read yet.

## Measurements and decisions

October 2026, Apple Silicon laptop. Startup: packaged build, 11 warm launches, see
[startup performance](startup-performance.md#current-baseline). SSH Host: the opt-in SSH integration
suite against the disposable `scripts/ssh-lab.ts` container on the same machine, 7 runs
(`CAXRI_SSH_INTEGRATION_REPORT`), p50 and p95 by nearest rank:

| Path                                          |  p50 |  p95 |
| --------------------------------------------- | ---: | ---: |
| Local first frame, empty profile              |  440 |  456 |
| Local first frame, seeded long-used profile   |  590 |  616 |
| Local Server Core attachment, seeded          |  410 |  436 |
| SSH Host cold install and attach              | 3606 | 3783 |
| SSH Host attach to a running Server           |  146 |  152 |
| SSH Host reconnect after losing the master    |  157 |  204 |
| SSH Host Desktop flow (open Project, Session) |  150 |  161 |

The SSH numbers exclude network latency; each reconnect is a handful of round trips, so a distant
host adds a small multiple of its round-trip time.

- **Painting a saved bootstrap before attachment: not now.** Locally the window already appears
  with its Workbench in about 0.6 s, and Server Core attachment (about 0.4 s) is the critical path,
  which a saved copy cannot shorten: the window waits for its placement, which Server Core owns. A
  saved Workbench could take at most about 150 ms off the first frame while risking actions
  against stale state at mount. Over SSH, a dropped connection already keeps the attached
  Workbench readable. Revisit if the seeded first-frame p95 passes one second, or when opening an
  SSH Host window while that host is unreachable becomes a reported need.
- **Incremental resume after reconnect: already in place.** Server Core's durable changefeed lets a
  reconnecting client continue from its cursor or fall back to a bounded ID snapshot
  ([ADR 0006](adr/0006-durable-changefeed-and-streaming-protocol.md)), and reconnect p95 is about 0.2 s. No extra
  client-side cursor store is needed.
- **Offline outbox: no.** Replaying a queued Agent submit or file write after a reconnect cannot
  prove it ran exactly once, and a resend can repeat an Agent turn. Persisting the drafts protects
  the user's text instead; sending stays an explicit action against a live Server.

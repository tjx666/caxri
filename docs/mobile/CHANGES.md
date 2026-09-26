# Mobile Changes

The Changes segment lets a paired device review the selected Session's Git changes. It is a
read-only view: the mobile gateway does not expose staging, commit, checkout, or arbitrary Git
commands. The Server resolves repositories from the authorized Session and Project; the app never
supplies a repository root path.

## Authorized snapshot and diff

`mobile.changes.list({ sessionId, refresh? })` returns a summary and changed files with opaque
`repositoryId`, bounded `repositoryName`, relative `path`, optional `originalPath` for a rename,
`M`/`A`/`D`/`R` status, and per-file added and removed line counts. The summary reports total files
and line counts, whether the Session has a Git repository, and whether the returned list was
truncated. The refresh button sends `refresh: true`; the Server forces a new Git snapshot without
changing other clients' refresh counters. Ordinary reads omit it. The list contains at most 100 files and is capped at 48 KiB; the
total may exceed the displayed rows.

The four-state mobile status maps a conflicted Git entry to `M`; resolve conflicts on the computer.

`mobile.changes.diff({ sessionId, repositoryId, path })` returns a unified text patch when available.
Its patch is capped at 48 KiB and 1,000 lines. A binary or oversized diff returns a status instead
of content; a file that no longer resolves in the current Git summary or has no current patch
returns `stale`.
The gateway limits the sealed response frame to 64 KiB. These bounds keep a large worktree or file
from filling a mobile response. They do not inspect or redact source content.

Untracked-file line counts and diff previews share a Server-wide eight-read file budget across
repositories and paired connections. Concurrent refreshes therefore retain the same per-file size
bounds without multiplying open descriptors by the number of requested files.

Both methods require a current paired device with at least the `view` role and a grant for the
Session's Project. The gateway and Server check the Session and current device authority, then
resolve the opaque repository ID within that Session's authorized Git summary. An unauthorized
Session is an authorization error, not an empty changes list. No absolute repository path is
returned to the app. See [Mobile authorization](AUTHORIZATION.md) for the role boundary.

## Updates and presentation

While the selected Session detail is visible and the app is foregrounded, it subscribes to
`{ kind: 'changes', sessionId }` so the header count stays current across segments. A scoped
`git.changed` event produces a content-free `changes.changed` hint; the app refreshes its TanStack
Query snapshot. When subscription is unavailable, the visible Session polls every 2.5 seconds.
Disconnect marks the last snapshot stale; reconnect reads it again. The view distinguishes loading,
empty Git repository, no Git repository, error, stale, and truncated-list states, with refresh and
retry actions.

The Session header shows the changed-file count once known. Each row shows its status, emphasized
filename, parent path, and line counts. When multiple repositories appear, the row also shows the
repository name; its accessibility label spells out the repository, status, and rename source. A
phone opens a full-page unified diff with line numbers, `+`/`−` markers, color, and horizontal
scrolling for long lines. Binary and oversized files show **This file is too large or
not text. Review it on your computer.** At a window width of at least 1100dp and a short side of
at least 600dp, a wide tablet keeps the preceding Conversation or Terminal view beside Changes in
the right pane, with the Session list still available on the left.

For a `reply` or `control` device with an Agent endpoint, **Ask Agent to commit** fills the current
Session's composer with `Commit the current changes with a clear message.` It does not send the
draft. The user must review it and tap **Send**. The Agent remains responsible for any Git
operation after receiving that instruction; the Changes view itself cannot commit.

## Implementation references

- [Mobile contract](../../packages/protocol/src/mobile/mobile-contract.ts) and
  [transport subscription](../../packages/mobile-transport/src/messages.ts)
- [Gateway authorization](../../apps/server/src/core/mobile/access-controller.ts),
  [Git projection](../../apps/server/src/domains/git/mobile-changes.ts), and
  [domain handler](../../apps/server/src/domains/mobile-handlers.ts)
- [Query observer](../../apps/mobile/src/features/changes/use-changes.ts),
  [Changes view](../../apps/mobile/src/features/changes/changes-view.tsx), and
  [diff view](../../apps/mobile/src/features/changes/changes-diff.tsx)

See [Mobile design](DESIGN.md#changes) for the interaction contract and
[Mobile transport](TRANSPORT.md) for encrypted framing and subscription recovery.

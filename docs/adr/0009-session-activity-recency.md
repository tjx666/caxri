---
kind: adr
status: accepted
---

# Session Activity owns Primary Sidebar recency

- Date: 2026-08-28

## Context

Session creation time is stable but leaves newly created work after older rows. Session visit time
supports MRU navigation, but using it for the Primary Sidebar makes selecting a Session move that
same row. A generic row-update timestamp is also incorrect: layout persistence, attention
acknowledgement, title reconciliation, and recovery writes are not evidence that work progressed,
while a Primary Agent can complete or request attention without an unrelated Session edit.

Agent Activity already means the Primary Agent's current state. Session Activity is a separate
piece of shared Session state: content-free evidence that work in the Session meaningfully changed.

## Decision

Server Core persists a strictly monotonic `sessionActivityAt` and a closed,
content-free `sessionActivityReason`. A new Session starts with `created`. Successful non-empty
human Terminal submission, explicit Agent start, and real Primary Agent transitions to running,
waiting, completed, or failed advance the clock. A normal or failed exit of the Primary Agent child
process therefore advances it, including a restored child that successfully spawns and then really
exits. An explicit close, restart preparation, orderly shutdown, or startup reconciliation does
not. Concurrent metadata observations for one Terminal are serialized, with
one trailing observation preserved when a refresh arrives during an in-flight read. The first
observation of a process generation establishes a complete reconciliation baseline; repeated
identical observations remain reconciliation, while later Primary Agent state transitions may
advance the clock. An interactive Agent PTY remaining alive at its prompt is not a running turn:
process lifecycle updates do not change Agent Activity, and a process-only metadata fallback is
`unknown`. An initial process-only reconciliation also clears an uncorroborated historical
`running` value while preserving settled and attention states. Selection, attention acknowledgement, rename, archive/restore, Session
View persistence, Terminal structure, output chunks, title-only probes, compaction, empty submit,
and bracketed-paste editing do not.

The preserving migration backfills legacy Sessions from `createdAt`, never `lastVisitedAt`, because
creation is the only historical event whose activity meaning is certain.

The Renderer derives Primary Sidebar order from Session Activity, newest first, within each existing
Project group. Creation time and ID provide deterministic fallbacks. (Later amended: a durable manual
`sidebarOrder` now sorts first and Session Activity breaks its ties, through
`compareSessionSidebarOrder`; Pinned Sessions sit in their own group ordered by `pinnedOrder`.) The Sidebar tree, command
palette, Project default selection, adjacent-Session commands, and Server fallback selection consume
the same comparison policy. Server storage queries retain their stable creation order. MRU
navigation continues to use `lastVisitedAt`, and Attention remains a visual signal rather than a
sorting bucket.

## Consequences

- Selecting or acknowledging a Session cannot reorder the Sidebar.
- Background work can move a Session without writing Terminal output or user content to SQLite.
- Every new activity source must make an explicit allowlist decision and choose a reason.
- Recovery and metadata baselining require regression coverage so stale provider state cannot look
  like fresh work.
- A new persistent field and N-1 migration are required, but no compatibility adapter or alternate
  read model is introduced.

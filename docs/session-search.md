---
kind: living
status: current
---

# Session search

Press `Command+Shift+S`, or run **Search Sessions** from the Command Palette, the Session menu,
or Archived Sessions. One picker finds every Claude, Codex, and Grok conversation on this machine,
whether it is an open Caxri Session, an archived one, or a conversation run in a plain terminal
that Caxri never saw.

## What it matches

A query matches a conversation's title, its message text, its folder, or its ID. Each term must
appear; ranking puts an ID match above a title match above a folder match above a message match,
then orders by relevance boosted toward recent conversations. A pasted ID or ID prefix of four or
more characters lands on that conversation first. An empty query lists recent conversations.

Message text means the visible user and assistant messages, extracted through the same boundary
title generation and the conversation reader use: tool calls and output, reasoning, sidechains,
injected instructions, and Terminal screen contents never match. Grok's stream chunks are joined
into one message first. Scripted runs (Claude `sdk-cli` entry points, Codex subagent threads) are
not conversations the user had and never appear.

A message match quotes the message with the matched terms highlighted. A row also shows the Agent,
where the conversation lives (open, archived, or not in Caxri), its folder, how many messages
matched, and when it last changed.

## Acting on a result

| Row          | Enter or click                                                               |
| ------------ | ---------------------------------------------------------------------------- |
| Open         | Opens the Session                                                            |
| Archived     | Restores the Session to the top of its Project and opens it                  |
| Not in Caxri | Adds it as a parked Session in the Project holding its folder, then opens it |

Adding an external conversation reuses the deepest Project whose root contains the folder, or adds
a Project for it. The new Session's Agent Terminal is bound to the conversation, so opening it
resumes the conversation. A conversation whose folder no longer exists cannot be added. A
conversation already held by a Session answers with that Session instead of a second copy.

`Tab` and `Shift+Tab` cycle the **All / In Caxri / Archived / Not in Caxri** filter; the Agent
chips narrow to one provider. The hovered or selected row also offers Copy ID.

## How it works

A Worker thread in Server Core owns a SQLite FTS5 trigram index at
`<userData>/session-search.db`. It discovers transcripts with the same provider discovery Usage
uses, reads new and grown files from a saved byte cursor, rereads rewritten files, and drops
vanished ones, newest first so recent conversations become searchable before old history finishes.
A search more than 30 seconds after the last pass starts another in the background and answers
from the index as it stands; the footer says when indexing is still running. Terms shorter than
three characters fall back to a substring scan of the indexed text.

The index is derived data. A schema or extraction change bumps its version, which drops and
rebuilds it instead of migrating. The Worker starts on the first search and exits after a minute
idle unless it is still indexing. If the index cannot be opened, search still finds Caxri
Sessions by title, folder, and ID and retries the index a minute later.

Status comes from Caxri, not the index: a conversation held by a visible Session's Agent Terminal
(or recorded in its usage ledger) is open or archived; a conversation held by a hidden Project's
Session never appears; everything else is external. Before adding an external conversation the
Server rereads its transcript, so a stale index row never decides the folder or title.

Diagnostic logs record only counts, durations, and closed reasons (`session_search.*` events):
never a query, title, path, or message text.

## Reference implementations

The design draws on CLI session browsers and Agent workbenches surveyed in the competitors skill's
[session history search notes](../.agents/skills/competitors/references/session-history-search.md);
the attribution table is in
[feature references](../.agents/skills/competitors/references/feature-references.md).

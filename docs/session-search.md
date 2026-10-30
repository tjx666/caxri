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
appear, and a term also splits where Chinese, Japanese, or Korean text meets digits or Latin
letters, so `42个token` matches a message that writes `42 个 token`. Ranking puts an ID match above
a title match above a folder match above a message match. Within each, a conversation with a
message holding the whole query as one phrase (spacing aside) comes first, then relevance boosted
toward recent conversations orders the rest. A pasted ID or ID prefix of four or
more characters lands on that conversation first. An empty query lists recent conversations.

Message text means the visible user and assistant messages, extracted through the same boundary
title generation and the conversation reader use: tool calls and output, reasoning, sidechains,
injected instructions, and Terminal screen contents never match. Grok's stream chunks are joined
into one message first. Inline Markdown markers (code spans, `**`, `__`, `~~`) are dropped from
both the indexed text and the query, so a sentence copied from a rendered Agent Chat message still
matches. Scripted runs (a Claude conversation whose first entry point is `sdk-cli`, Codex subagent
threads) are not conversations the user had and never appear. A Claude conversation an application
started (Caxri's own `caxri` entry point, which every Claude process Caxri starts carries, or any
other `sdk-*` entry point) appears only while a Caxri Session holds it, so Agent Chat conversations
are searchable by content while another application's SDK runs stay out. The index reads such a
transcript's messages only once a Session holds it (a hosted file nobody holds keeps a row but no
text, so scripted SDK runs add nothing to the index), and the "still indexing" count leaves out the
hosted conversations no Session holds.

### Operators, relaxation, and the current Project

The query accepts `agent:claude|codex|grok`, `project:<text>` (or `project:"two words"`),
`before:YYYY-MM-DD`, and `after:YYYY-MM-DD`. They narrow the search and are not matched as words:
`agent:` repeats widen to several Agents and combine with the Agent chips by intersection,
`project:` keeps conversations whose folder contains the text (case-insensitive), `before:` excludes
the given local day and later, and `after:` includes that day and later. An operator with an unusable
value (an unknown Agent, a date that does not exist, an empty project) stays in the query as plain
words. The result carries the parsed `filters` so a client can show them as removable chips; the
operators work in the CLI's `session search` as well.

When no conversation holds every word, the Server loosens the query one step and reports it in
`relaxation`: `phrase` (the query as typed, including a message holding the whole phrase), `allWords`
(every word, but never as one phrase), or `anyWord` (at least one word, only when nothing holds them
all). A request may also pass `currentProjectId`; conversations inside that Project (and its Sessions)
then sort ahead of every other result, and none is dropped.

In the dialog, each parsed operator appears as a removable chip under the filter bar; dismissing a
chip deletes that operator from the query text. A relaxed search shows a notice above the results
(`allWords`: "No exact phrase match; showing results containing all words"; `anyWord`: no result
holds every word). While a Project is selected the dialog sends it as `currentProjectId`, so that
Project's conversations lead; the "All Projects" toggle (`Option+P`) stops sending it. Each entry
that belongs to that Project carries `isCurrentProject`. The sort toggle (`Option+S`) switches
between Relevance (the Server's order) and Recent (newest activity first, current-Project
conversations still ahead), re-sorting the loaded results without another request. `Tab` and
`Shift+Tab` keep cycling the Where and Agent filters.

Whitespace is one rule everywhere: any run of spaces, tabs, line breaks, or paragraph breaks in a
query or a quoted message reads as one space (`normalizeSessionSearchWhitespace`). The query handed
to Chat find follows it, and Chat find matches a space against any whitespace in the rendered text,
including the break between two paragraphs, so a sentence pasted across paragraphs finds its message.

A message match quotes the message with every matched term highlighted (the phrase message when
there is one), prefixed by who wrote it
(the user or the Agent). A row also shows the Agent,
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

Opening a message match also opens find in the conversation's Agent Chat with the query: the whole
query when the quoted message holds it as one phrase, written as the message spaces it, otherwise
its longest matched term. The first
match is highlighted and scrolled into view, and Enter steps through the rest. When the match lies
in older history than the Chat has loaded, find loads older pages one after another until the match
appears, the history ends, or a page fails, then lands on it; typing a new query or closing find
stops the loading. Search earlier messages stays available for a manual search. A conversation shown
as a PTY Terminal opens as before.

`Tab` and `Shift+Tab` cycle the **All / In Caxri / Archived / Not in Caxri** filter; the Agent
chips narrow to one provider. The hovered or selected row also offers Copy ID.

## Preview

The selected result shows a preview pane to the right of the list (below it when the dialog is
narrow). It quotes the newest message that holds every query term (the one the row quotes) with the two messages before and
after it, the matched terms underlined and bold, and long messages cut around the match. `Alt+Down`
and `Alt+Up` (or the chevrons in the pane header) step through the other matching messages of that
conversation and wrap around. A conversation with no matching message text (a title, folder, or ID
match, or an empty query) shows its last five messages. A conversation not in Caxri is labelled as
such: previewing reads the index only, so it creates no Session and writes nothing to Caxri's
database. The pane follows the selection after a short pause and does not change what Enter does.
Messages render as plain text, not Markdown, because the index stores text with its inline Markdown
markers already dropped.

## How it works

A Worker thread in Server Core owns a SQLite FTS5 trigram index at
`<userData>/session-search.db`. It discovers transcripts with the same provider discovery Usage
uses, reads new and grown files from a saved byte cursor, rereads rewritten files, and drops
vanished ones, newest first so recent conversations become searchable before old history finishes.
A search more than 30 seconds after the last pass starts another in the background and answers
from the index as it stands; the footer says when indexing is still running. Terms shorter than
three characters fall back to a substring scan of the indexed text. A transcript's first prompt is
read whole even when a pasted screenshot inlined in it outweighs the head read, with the image data
collapsed as it is read, so such a conversation is never skipped as unreadable. When attachments,
injected context, or tool results push a Claude conversation's first visible user message past the
head read, reading continues up to 16 MiB further until that message appears, so the conversation
is indexed and titled by it like any other. A conversation with only built-in commands such as
`/clear`, or no messages at all, is still left out.

The index is derived data. A schema or extraction change bumps its version, which drops and
rebuilds it instead of migrating. The Worker starts on the first search and exits after a minute
idle unless it is still indexing. If the index cannot be opened, search still finds Caxri
Sessions by title, folder, and ID and retries the index a minute later.

Status comes from Caxri, not the index: a conversation held by a visible Session's Agent Terminal
(or recorded in its usage ledger) is open or archived; a conversation held by a hidden Project's
Session never appears; everything else is external. Before adding an external conversation the
Server rereads its transcript, so a stale index row never decides the folder or title.

The preview is the owner-only read `session.searchPreview`, answered by the same Worker from the
indexed messages by position, never by re-parsing the transcript.

Diagnostic logs record only counts, durations, and closed reasons (`session_search.*` events):
never a query, title, path, or message text. Each index pass counts the transcripts it stored as not
a conversation by cause (scripted run, subagent sidechain, delegated task, missing folder or prompt,
unreadable, and a few more), and logs at warning level when a first record ran past the head read's
caps, the one cause that hides a real conversation.

## Reference implementations

The design draws on CLI session browsers and Agent workbenches surveyed in the competitors skill's
[session history search notes](../.agents/skills/competitors/references/session-history-search.md).
Opening a message match on the matched message follows Wake and agentsview, and the speaker prefix
on a quote follows Orca's role label. The attribution table is in
[feature references](../.agents/skills/competitors/references/feature-references.md).

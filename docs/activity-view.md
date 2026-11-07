---
kind: living
status: current
---

# Activity view

The Activity view is one of the Primary Side Bar's two bodies. It answers one question across every
Project: **which Sessions are waiting on me right now.** The other body, the Project tree, answers a
different question (which Sessions exist) in the order the user arranged them, so a Session that
needs attention is deliberately never promoted there. Keeping the two orders apart is the point: one
is the user's filing, the other is a queue.

They take turns in the same column rather than sitting side by side. Both describe the same
Sessions, so showing them at once renders every row twice and makes the side bar argue with itself
about what matters. Codex's desktop app and T3 Code both put the queue in the left side bar for the
same reason; Orca keeps the tree and slides a dashboard over it, which still has the two competing
for one column.

Switch with the to-do list button in the side bar header, `Cmd+Alt+U`, or the Command Palette
entry **View: Toggle Activity**. The icon pictures a queue of work rather than a notification: the
Status Bar already ends in a bell holding app notifications, and an inbox tray marks the Peer
Inbox's held peer messages. The button carries the number of Sessions with Unread Attention, so the
tally is legible while the tree is showing, which is exactly when the queue is unmounted.
`Cmd+Shift+N` jumps to the next Session that needs you, revealing the queue on the way so the user
can see what else is in line.

## What lands in the list

Every non-archived Session whose owning Project is visible at the Primary Side Bar's top level.
Auto-registered worktree Projects are hidden there, so their Sessions are hidden here too: a row
naming a Project the user never added would be unreachable from this list.

Rows are grouped, and the groups are ordered:

| Group           | A Session is here when                                                   |
| --------------- | ------------------------------------------------------------------------ |
| Needs attention | It has Pending Attention and its Agent is not running                    |
| Working         | Its Agent is running, including compaction and background waits          |
| Idle            | Everything else, including a usage-limit wait and a quiet detached Agent |

A Session enters **Needs attention** when an Agent turn ends: it finished, asked a question, or
failed (a dead Agent process counts as a failure). **Reading it does not move it.** The user often
opens a finished Session, has not decided the next step yet, and switches away to handle another
one; when reading moved the row into a 15-minute "Recently finished" group, it left the queue
exactly while it was still the user's move, and Waiting, Failed, and Recently finished split one
question ("is it my move?") across three headings. A Session leaves only when:

- the user marks it done: the row's check button, **Mark as Done** in its context menu, or
  `Delete` / `Backspace` on the selected row (`session.markDone`);
- a new turn starts, from the user's prompt or because the Agent resumed on its own;
- its question is answered elsewhere.

A Session marked done goes to the top of **Idle**. GitHub notifications and Linear's Inbox separate
"read" from "Done" the same way, and Orca's smart order keeps the same three tiers. Unread Attention
still exists, but only decides how a row looks (a medium-weight title), never its group.

Every group lists the newest arrival first, keyed by when the row entered the group, and that key
holds still while the row stays there: a row moves when it changes group, never on its own, so the
list does not shuffle under the user. Urgency comes before recency only inside **Needs
attention**, where a question or a failure comes first because the Agent is blocked until the user
answers, then every other result (a merged pull request included; its glyph already says so, and a
merge landing on GitHub must not reorder the queue). Needs attention keys on the Session Activity
clock, which last moved when the turn ended, asked, or failed. **Working** keys on `turnStartedAt`,
when the latest turn started (the user's last message or the Agent starting): a turn that ends into a
background wait (background shells, subagents, monitors) advances the activity clock but not this
one, so the row stays where its turn began and only its glyph turns to the dotted ring. **Idle**
ranks by the later of the work clock and the moment the user marked the Session done
(`attentionResolvedAt`), so a just-resolved Session lands on top without its activity clock moving,
since that clock also orders the Project tree.

Each heading leads with its own muted glyph: a raised hand, a bolt, and a moon, so a group is found
by shape before its label is read, as in Paseo's status list. **Needs attention** is a raised hand
rather than a bell because the Status Bar's notification center owns the bell.

An empty group is not rendered.

Every heading after the first draws a hairline above itself with 24px of space, and headings use the
foreground color in 12px semibold with a muted count. Before that a heading was one muted 11px line,
about as tall as a row's own second line, so the groups ran together into one long list and the end
of **Needs attention** was hard to find; a 12px gap with an 11px label still let Pinned, Needs
attention, and Working read as one list. Paseo spaces its status groups the same way.

Every group collapses from its heading to that heading and its count, and the choice persists across
launches (`useAgentActivityGroupCollapse`). Pinned shares the Project tree Pinned group's record, so
the two bodies never disagree about it. **Pinned** and **Idle** can grow without bound, so they show
their newest five Sessions and the Project tree's `Show N more` row, stepping by ten
(`WINDOWED_SESSION_LIST_GROUPS` and `sessionListWindow` in `@caxri/protocol`, the same window the
phone's home list uses). **Needs attention** and **Working** always list everything, because a
hidden row there is work nobody sees. The selected Session stays on screen below a window, and the
revealed counts reset on relaunch like the Project tree's. Orca and Paseo both make every Activity
status group collapsible; T3 Code windows its Settled shelf the same way.

## Starting a Session

The Activity body replaces the Project tree, which holds the only other pointer entry to a new
Session (the Project heading's pencil). The queue therefore keeps a **New Session** row above its
scroller, outside the tree because it is not a row of the queue, and it does not scroll away. Its
trailing edge names the target Project: the one the user last picked in this row's list, else the
selected Session's, else the first listed Project. The pick is remembered on this device
(`activity-session-project-store.ts`), so closing the menu without choosing an Agent, selecting
another Session, or relaunching keeps it; before that the row reverted to the selected Session's
Project as soon as the menu closed.

### Fresh Chat

While Agents open in Chat (`session.openAgentsInChat`, on by default), a press on the row and
`Cmd+N` (`session.create`) while the side bar shows Activity open a **fresh Chat** in that Project at
once, with no menu (`fresh-chat-commands.ts`). Its Agent is `session.defaultAgent`, else the last
pick from a New Session list, else the first Chat-capable Agent; a default or last pick that cannot
open in Chat (Shell, a Terminal-only Agent) keeps the press repeating it, as before.

```text
Start in [beta ▾] with [Claude ▾]          ← empty Chat, until the first message
```

- Choosing another Project (most recently visited first) or Agent creates a fresh Chat there,
  remembers the choice like a list pick, and discards the old one quietly.
- The first message locks both: the line gives way to the conversation.
- Leaving a fresh Chat while it is still empty calls `session.discardIfEmpty` and shows "Discarded
  empty Session". Server Core deletes only a Session whose every Terminal is a Chat that never
  admitted input and has an empty projection (`AgentChatService.isUntouched`), without the native
  confirmation `session.delete` asks for; anything else answers `discarded: false` and stays.
- The fresh set is window-local memory: a reload forgets it, and those Sessions simply stay.

Codex's and Claude Code's desktop apps, and T3 Code's draft thread, likewise let a new thread
choose its Project on its first screen. The Project tree's entries and the Terminal surface keep
their own flows.

### New Session list

The row's chevron opens the New Session list, which is also where another Project is chosen: with
more than one Project it leads with a **Project** choice that re-targets the Agent options below it
and keeps the menu open, after T3 Code's sidebar New thread, which asks for the Project the same
way. The Agent options, Empty Session, and Import Conversation are the Project heading's own list.
Without an Agent that opens in Chat, the row's press repeats the default Agent or last pick, or
opens this list when there is none, and `Cmd+N` reaches the same menu: `openSessionCreationMenu`
hands a Project-heading claim to this row's `activity` anchor, since no Project heading is mounted
to open it.

The group rules, their order, and the in-group order live in
`packages/protocol/src/domain/session/session-activity-group.ts`, which the phone's home list and
the Server's capped mobile dashboard also use, so a Session sits under the same heading on Desktop
and on the phone. Pending Attention is Server state (`resolvedAttentionGeneration` beside the
attention and acknowledged generations), so marking a Session done on one Client clears it on
every Client. `session.markDone` names the attention generation it resolves, so a tick that races
a newer turn's result does not clear that result.

Detaching an Agent hands it to another client and stops its Terminal; it does not update the
Session's last Agent Activity, which stays frozen at whatever the final probe recorded. A detached
Session is therefore never listed under **Working**, but a result it left pending stays under
**Needs attention**: detaching resolves nothing.

**Attention outranks Working on purpose.** A running Agent asks nothing of the user until it stops,
and sending the next prompt is what moves a Session into Working. A Session with an old pending
result whose Agent is running again is listed under **Working**: a hook-reported new turn resolves
the previous turn's attention and acknowledges it, so an Agent that resumes on its own (Claude Code
continuing after a background shell finishes) reads as Working instead of staying under **Needs
attention** until the new turn ends. A `running` reading inferred only by a metadata probe resolves
nothing; it only lists the Session under Working while it lasts.

## Visual grammar

A row is the Session title on its own line, the Agent, Project, worktree, and time beneath it, and
a pull request glyph at the right edge, centered on both lines. The Session's status glyph leads
the title:

```text
◉ Rate limiter for /v1/search              ⇡
  ✳ api-server ⑂ api-server-rate-limit · 18m ago
```

The second line says where the Session runs, in the order a user narrows it down: which Agent CLI
(its identity icon), which repository, and (only when the Session works in a linked worktree rather
than its Project root) which worktree, marked by the same `FolderTree` worktree glyph the status bar uses.
The pull request glyph is the Project tree's own, colored by lifecycle, in the same right-edge slot.
It is centered on the whole row rather than on the title line, so it belongs to the Session instead
of floating in the row's top-right corner. The title clips with the Project tree's right-edge fade
rather than an ellipsis.

**The status glyph is the Project tree's own.** `SessionStatusIndicator` draws it in both bodies of
the side bar from one projection (`sessionStatus`), which follows the same rule this view groups by:
a **Working** row spins (the slower dotted ring while it only waits on background shells,
subagents, or monitors), a **Needs attention** row shows an amber mark (a `?` for a question, a dot
for a result) that breathes until the row is marked Done and ripples three times when a new result
arrives unread, and a plain **Idle** row shows nothing. A group heading is out of view once the list
scrolls, and the glyph keeps the state readable on every row, the way it already is in the Project
tree. Every row reserves the 14px glyph slot, so every title shares one left edge even though
Idle rows leave it blank. An unread title is set in medium weight, which tells it apart from a read
**Needs attention** row carrying the same mark. With excerpts off, a waiting row adds "Waiting for
you" to its second line and a failed row a `✕` and "Failed", since those two tiers are the ones
that block the Agent. Only the failure carries a second-line mark: a question's leading glyph is
already a `?`, while a failed result's glyph is the same amber dot as a finished one.

A Claude Code turn that
ended while background subagents, workflows, or monitors it started still run stays under
**Working** but swaps the spinner for a slow, muted dotted ring: it is waiting for that work to
wake it, not busy, and it is not ready for review. A background shell holds the turn the same way
(a test run or a CI watch whose result the Agent still needs), unless its command matches
`agents.longRunningShellCommands` (Settings > Agents > Long-running background commands): a dev
server, log tail, or emulator can outlive the turn by hours, so those settle it as usual. The
default list names the common development servers; add a project's own, such as
`bun run *switch-worktree.ts dev`. Patterns follow the shared shell command pattern syntax in
`packages/protocol/src/configuration/shell-command-patterns.ts`: a text pattern is a prefix that ends
at whitespace (`bun run dev` matches `bun run dev --port 3000`, not `bun run devtools`), `*` matches
any characters, a bare command name matches it from any directory, `/source/flags` is a regular
expression, and each sub-command joined by `&&`, `;`, or `|` is checked on its own after leading
`NAME=value` assignments and wrappers such as `env`, `nohup`, and `timeout` are skipped. The
Terminal hook bridge matches the command locally and sends Server Core only the resulting boolean,
so command text never crosses the bridge; a Chat matches its own task list the same way. A shell
whose command is unknown (only the Agent's description of it, or an unreadable pattern file) does
not hold the turn, so a misclassified dev server never leaves a Session working. Orca's
quiet monitoring sub-mode is the precedent for keeping this inside running instead of adding a
state; VS Code's `chat.tools.terminal.autoApprove` keys and Claude Code's `Bash(...)` permission
rules are the precedent for the pattern syntax.

Color follows the two-tier rule: only attention (the amber status glyph and the "Waiting for you" phrase) and
failure (the `✕` mark) are tinted, warning or danger, so that weight always means "this one wants
you" and never has to be decoded against a legend; running glyphs stay muted.

The title takes a line to itself. The location and time share a fixed-height line below it: when
space runs out, the entire time disappears first, then the worktree name truncates, and the Project
truncates last. CSS wrapping and clipping
keep this priority independent of text length without measuring in JavaScript or changing the row
height. Both names clip with the Project tree's right-edge fade rather than an ellipsis, matching the
title above them; a short, unclipped name never shows the fade, because each name's box reserves the
fade's own width as trailing padding instead of letting the mask reach real characters (issue #1173).
A Project wider than the entire line still truncates visually; its text remains complete
for assistive technology and the row's hover card shows the full name. The Project has priority
because it is the only thing telling the user which repository a row belongs to. A clipped title
reveals its tail on hover or keyboard focus the same way a Project tree title does, through the same
`useSessionTitleScroll` hook.

The queue's own scroller carries the Project tree's VS Code-style inset shadow once it scrolls away
from the top, through the same `useScrollEdge` binding
([secondary-sidebar-trees.md](secondary-sidebar-trees.md#scroll-cue)), so every side bar body
signals hidden content above identically.

A **Needs attention** row has two hover actions, **Archive** then the **Mark as Done** check:
handling an item often ends by throwing it away, so Archive sits beside Done instead of only in the
context menu. **Pin** and **Unpin** live in the context menu only: the queue is scanned by
attention, and a pin chip flashing on every hovered row was noise there, unlike in the Project tree.
The actions appear at the row's right edge on hover, keyboard focus, or selection, where the Project
tree keeps its row hover actions: over the pull request glyph when the Session has one, in a slot
that widens to fit both while they show. They are siblings of the row button, so pressing one never
selects or opens the Session. Archive advertises no key here, because Delete marks the row Done.

Rows wear the Project tree's Session hover card and context menu, so a Session reads and acts the
same in either body of the side bar. The Project name carries no tooltip of its own, because a
second hover popup on one row would compete with the card. A row with Pending Attention gets **Mark
as Done** in its menu (Delete's pointer twin). **Rename** opens the same inline editor as the
Project tree, including on an unselected row.

## Interaction

The list is one ARIA tree with a single Tab stop. Group headings are collapsible tree items and
focus stops, like the Project tree's Project and Pinned headings; a `Show N more` row is a focus stop
too.

| Input                   | Result                                                         |
| ----------------------- | -------------------------------------------------------------- |
| Click, `Enter`, `Space` | Select that Session; reading it does not move it               |
| Same on a heading       | Collapse or expand that group                                  |
| `Left` / `Right`        | Collapse / expand the focused heading's group                  |
| `Up` / `Down`           | Move between rendered rows, headings included                  |
| `Home` / `End`          | First / last rendered row                                      |
| `Delete` / `Backspace`  | Mark the row done, moving it to the top of Idle                |
| Row's check button      | The pointer equivalent of Delete                               |
| Row's Archive button    | Archive the Session (Needs attention rows)                     |
| Double-click, Rename    | Edit that Session's title inline                               |
| `session.rename`        | Edit the selected Session's title inline                       |
| Right-click             | The Session context menu, with Mark as Done when pending       |
| `Cmd+Shift+N`           | Select the next Session needing attention, wrapping at the end |
| `Cmd+Alt+U`             | Switch the side bar between the Project tree and this queue    |

`Delete` marks the Session done here rather than archiving the Session, which is what the same key does
in the Primary Side Bar. The two lists answer different questions, and removing an item from a queue
is what Delete means in a queue.

Switching bodies hands the keyboard over. The body that leaves is unmounted, taking any focused row
with it, and the browser then drops focus onto `document.body`, which silently restarts the next
Tab from the top of the document. `refocusChromeSurfaceBody` in
`apps/desktop/src/renderer/src/stores/chrome-focus-handoff.ts` moves focus to the arriving body's
own entry point instead, but only when focus was inside the side bar to begin with: someone typing
in a Terminal who presses `Cmd+Shift+N` asked to see what is waiting, not to hand over their
keyboard.

### Mode is device state, not Session state

Which body the side bar shows lives in the Renderer's chrome layout
(`primarySidebarActivityMode`), beside the panel widths and visibility flags, and persists to
`localStorage`. It is deliberately not Session-owned: this queue spans every Project, so tying the
mode to the selected Session would flip the side bar's contents underneath a user walking the queue:
the list would vanish on its own first click.

Switching modes unmounts the body that leaves, rather than hiding it. Keeping both alive would mean
a hidden Project tree still polling pull requests, or a hidden queue still re-projecting every
Session on every record change, purely to preserve a scroll position behind a surface nobody can
see. The Project tree's own expansion state survives regardless: it lives in its own store, not in
the mounted component.

### `Cmd+Shift+N`, and why not `Cmd+Shift+` backtick

The natural pairing was the shifted form of Session MRU's `Cmd+` backtick, its default when this
chord was chosen. Session MRU now defaults to `Ctrl+Alt+Tab` so that `Cmd+` backtick stays with the
macOS window cycle across Caxri windows, but the shifted chord is unusable either way: on a US macOS
layout Shift turns Backquote's printable value into a tilde, so the chord never matches a stored
`cmd+shift+` backtick, and for a user who rebinds Session MRU to `Cmd+` backtick,
`resolveKeydownBinding`'s unshifted fallback hands that exact stroke to `session.switchMru` for
reverse cycling.
`use-command-shortcuts.test.ts` guards the shipped default set against a future binding that walks
into the same trap.

## Where the code lives

| Path                                                         | Owns                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `apps/desktop/.../primary-sidebar/primary-sidebar.tsx`       | The shell that picks one of the two bodies                   |
| `.../primary-sidebar/primary-sidebar-header.tsx`             | The toggle, its badge, and the accessible tally              |
| `.../primary-sidebar/primary-sidebar-project-tree.tsx`       | The other body, split out so mode switching unmounts it      |
| `apps/desktop/src/renderer/src/stores/chrome-layout.ts`      | `primarySidebarActivityMode` and its persistence             |
| `.../features/agent-activity/agent-activity-rows.ts`         | Grouping, ordering, the next-attention walk, the badge tally |
| `packages/protocol/.../session/session-activity-group.ts`    | Group order and row order shared with mobile and the Server  |
| `.../agent-activity-tree.ts`                                 | Flattening, collapse, windows, and keyboard row math         |
| `.../hooks/use-agent-activity-group-collapse.ts`             | Which groups are collapsed, persisted to `localStorage`      |
| `.../session/create-session-menu.tsx`                        | The New Session row (`ActivitySessionCreationMenu`)          |
| `.../hooks/use-agent-attention-count.ts`                     | The tally the badge and the Zen Mode attention dot both read |
| `.../agent-activity-view.tsx`, `agent-activity-row-item.tsx` | Rendering, roving focus, and mark-read                       |
| `.../agent-activity-commands.ts`                             | `session.focusNextAttention`                                 |
| `e2e/agent-activity.e2e.ts`                                  | The cross-Project workflow through a real launch             |

Every Session, Project, and Terminal record this list groups is already in the Renderer's bootstrap
store, so the queue is projected client-side, and only the selection, the read acknowledgement, and
`session.markDone` travel over IPC.

The projection groups Terminals by Session once per pass (`sessionTerminalIndex` in
`features/session/session-agent-terminal.ts`) instead of scanning every Terminal for every Session,
so one pass is linear in Sessions plus Terminals and resolves the same Terminal as the single-Session
`sessionAgentTerminal` lookup. It runs only while the queue is mounted, because a hidden queue is
unmounted rather than kept alive. `session.focusNextAttention` computes its own copy from the store
on demand instead of reading the mounted view's, so `Cmd+Shift+N` still works while the queue is
hidden or was never opened.

## Excerpts

With **Show Agent excerpts in Activity** on (`agentActivity.showExcerpts`, off by default), a row in
the attention group quotes what the Agent last asked or said so the user can decide whether to open the Session. `agent.excerpts` (read-only, one batch
per view) answers per Session and attention generation: a Chat Agent that is waiting on the user
shows the question or approval it is asking, read from the live Chat's in-memory request without
starting a provider; every other case shows the closing message of the latest turn from the on-disk
transcript. When the Chat has a current away recap
([Agent Chat: Away recap](agent-chat.md#away-recap)), the row shows that recap instead of the reply
(`kind: recap`, led by a sparkle glyph and spoken as "Recap:"), but never in place of a pending
question or approval. A Terminal Agent has no live request to read, so it only gets the transcript's last
reply. Rows clamp the quote to two lines. The text is user content shown
locally: the Server never persists or logs it, and the Renderer keeps it only in the query cache.
A new recap is announced with the transient `agent.recapChanged` event, which refetches the
Session's excerpt. Off by default because the quote doubled every row's height and the title plus
status line was enough to decide what to open; while off, no excerpt is fetched.

## Past conversations

The Session row's context menu offers `Reopen previous conversation`, a submenu of every Agent
conversation the Session hosted that is no longer open in a Terminal (newest binding first, up to
12). The record is the `agent_session_usage` ledger, since `terminals.agent_session_id` holds only
the current binding and `/clear`, a provider switch, or closing the Terminal overwrites it. Titles
come from Session search's index (`session.agentHistory`); a conversation since resumed in another
Session is left out. Choosing one (`session.reopenConversation`) adds a parked Agent Terminal bound
to it in the ledger's recorded folder, and revealing that Terminal resumes the conversation, as an
imported conversation does. The Session hover card does not repeat this list: after the Codex app's thread list, it is a
two-line glance at the title, the Agent, the latest activity time, and the Project. Status, the PR,
and unread attention stay on the row and in its accessible description.

## Returning to a Session

Selecting a Session whose Chat finished turns while the user was away shows a quiet pill at the
bottom of the transcript ("N turns since you last looked") with a jump to the first of them and a
close button. The pill shows only while the first missed prompt is above the view, so one long missed
turn still offers a way back to its start, and it shares the bottom slot with Jump to latest: it
shows while the latest entry is in view, and once the user scrolls or jumps up, Jump to latest takes
the slot, so the two never overlap. The bottom keeps the pointer near the composer instead of sending
it across the pane.
The Renderer records when the user stopped looking (Session switch, window blur, or hidden window)
before it marks the Session read, and counts the Agent turns whose end time falls inside that
absence, not the attention epoch, which also moves for questions inside one turn. The window keeps
that boundary in memory; Server Core also records it from window presence in
`sessions.last_viewed_at` whenever the Session stops being the one in the focused, visible window,
including when Desktop quits and its connection drops. A restarted Renderer uses that durable copy
(`SessionRecord.lastViewedAt`) for its first look at each Session, so the pill still counts what
finished while Caxri was closed. Turn end times come from Server Core's live Chat projection, so a
Server Core restart, whose replayed history carries no timing, still shows nothing. Reloading the
Renderer while looking at a Session keeps the previous leave as its boundary, because presence never
saw the user stop looking.

## Non-goals

This view reports state; it does not schedule work. Beyond the New Session row it offers no way to
create Sessions, and it does not dispatch Agents,
summarize transcripts itself (an excerpt is a clipped quote of the Agent's own words; the only
summary it shows is the away recap the Agent wrote about its own Chat), or
add event granularity beyond the six `AgentActivityState` values.
[Issue #601](https://github.com/tjx666/caxri/issues/601) tracks a larger butler-window design whose
queue board would reuse this projection.

See [Notifications](notifications.md) for the transient toast and reminder path, and
[GLOSSARY.md](../GLOSSARY.md) for the Agent Activity, Attention, and Unread Attention vocabulary this
view renders.

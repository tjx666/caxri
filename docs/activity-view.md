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

| Group             | A Session is here when                                          |
| ----------------- | --------------------------------------------------------------- |
| Needs attention   | It has Unread Attention                                         |
| Working           | Its Agent is running, including compaction and background waits |
| Waiting           | Its last Agent Activity was `waiting` and has already been read |
| Failed            | Its last Agent Activity was `failed`                            |
| Recently finished | It completed within the retention window below                  |
| Idle              | Everything else, including a detached Agent that did not fail   |

Each heading leads with its own muted glyph: a raised hand, a bolt, an hourglass, a warning
triangle, a double check, and a moon, so a group is found by shape before its label is read, as in
Paseo's status list. None of them reuses a row glyph's circle family: the heading names the section,
and repeating the row glyph above its own rows would say the same thing twice. **Needs attention**
is a raised hand rather than a bell because the Status Bar's notification center owns the bell.

An empty group is not rendered. Inside a group, rows keep Session activity recency, so the newest
event in a group is always its first row.

The group rules, their order, the retention window, and the in-group order live in
`packages/protocol/src/domain/session/session-activity-group.ts`, which the phone's home list also uses, so
a Session sits under the same heading on Desktop and on the phone. The phone differs in one place:
its home list is its only Session list, so a finished Session past the window moves to **Idle**
instead of leaving.

Opening an unread Session acknowledges it immediately, but the selected row stays in its current
place while Activity remains open and that Session is selected. This is a temporary display anchor,
not unread state: the **Needs attention** heading and side bar badge count only actual unread
Sessions, and the next attention command uses that same set. If the viewed row is the only one left
there, the heading reads **Viewing** with no count. The viewed row loses its attention tint and
mark-read action. Selecting another Session, switching to the Project tree, or leaving Activity
releases the anchor; the row then takes its current group or leaves the list if it is no longer
recent. A new Agent activity or attention generation also releases the anchor so live work is not
frozen in an old group.

Detaching an Agent hands it to another client and stops its Terminal; it does not update the
Session's last Agent Activity, which stays frozen at whatever the final probe recorded. A detached
Session is therefore read as quiet rather than by that frozen value: otherwise one detached
mid-turn would sit under **Waiting** while its own row read "Detached". The one exception is
**Failed**: detaching resolves nothing, and nothing else will clear a failure.

**Attention outranks Working on purpose.** Caxri's unread flag means "something happened that you
have not opened yet", which is a property of the user's queue rather than of the Agent, so it
belongs above any turn still in progress, including that same Session's turn, since a Session can
be both unread and running. herdr and Kero rank their rollups the same way; Orca and T3 Code put
running work first because their lists describe live work rather than a to-do queue.
A hook-reported new turn is the exception that ends this overlap: it supersedes the previous turn's
attention and acknowledges it, so an Agent that resumes on its own (Claude Code continuing after a
background shell finishes) reads as Working instead of staying under **Needs attention** until the
new turn ends. A `running` reading inferred only by a metadata probe does not acknowledge anything.

### Retention

A finished Session stays listed for 15 minutes after its last activity
(`SESSION_FINISHED_RETENTION_MS`), then drops out. Without a window, "Recently finished"
would grow into a permanent archive of every Session that ever completed, and the queue would stop
being readable at a glance. A **Failed** Session is deliberately exempt: nothing else will clear it,
so ageing it out would silently lose the only place that failure is reported.
The currently viewed row stays visible even after this window expires; it leaves when the user
switches away, not while they are reading it.

`useAgentActivityClock` subscribes to the same 30-second window clock the relative-time labels use
rather than starting a second timer, so a row's "12m ago" and the window that label is about
turn over in the same tick. It needs no visibility gate: the queue exists only while the side bar is
showing it, so switching back to the tree stops the clock by unmounting its only consumer.

## Visual grammar

A row is a state glyph, the Session title on its own line, the Agent, Project, worktree, and time
beneath it, and a pull request glyph at the right edge, centered on both lines. There is no state phrase on the row at
all:

```text
⊘  Rate limiter for /v1/search              ⇡
   ✳ api-server ⑂ api-server-rate-limit · 18m ago
```

The second line says where the Session runs, in the order a user narrows it down: which Agent CLI
(its identity icon), which repository, and (only when the Session works in a linked worktree rather
than its Project root) which worktree, marked by the same `worktree` codicon the Project tree uses.
The pull request glyph is the Project tree's own, colored by lifecycle, in the same right-edge slot.
It is centered on the whole row rather than on the title line, so it belongs to the Session instead
of floating in the row's top-right corner. The title clips with the Project tree's right-edge fade
rather than an ellipsis.

**The state is a shape because every group heading already names it.** A row under **Working** that
also printed "Working" repeated its own heading, and three of the six groups did exactly that, word
for word. The words are not gone: `agent-activity-glyph.ts` keeps them as the glyph's `aria-label`
and its shared tooltip: they are just no longer spent on a line that has 230px to work with. Orca and
T3 Code reached the same place from a different direction: neither groups by state, and both still
chose a glyph over a colored word because a shape is what a scanning eye resolves first.

Six states, six shapes: a check for a finished turn, a question mark for one waiting on you, a cross
for a failure, a spinner while the Agent runs, a hollow circle for idle, a dashed one when no
activity was ever reported. A detached Agent shows the unplugged glyph instead of its frozen state. A Claude Code turn that
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

Color is the one thing the shape does not carry, and it follows the two-tier rule: only
**Needs attention** and **Failed** rows are tinted warning or danger, so that weight always means
"this one wants you" and never has to be decoded against a legend. The one exception is the
**Working** spinner, which is `--success` green: it is the only motion in the list, and in muted grey
it read as a loading placeholder rather than an Agent making progress. It cannot be confused with a
request, because an unread running Session sits under **Needs attention** with its attention glyph. An unread row's tint comes from _why_ it needs
the user (`sessionUnreadTone`), not from what its Agent is doing right now: a completed turn is a
neutral state, which would print the commonest unread row of all in the same grey as an Idle one,
and an unread Session still running is a success state, which would put green under "Needs
attention".

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

An unread row's mark-read button follows the Project tree's hover-action rule: the same `--elevated`
chip, centered on the right edge with a **Mark as Read** tooltip, and on hover the row's text makes
room and fades before it instead of painting under it. It reserves no width at rest, because a slot
held for a hover-only action would cost every unread row the width its Project name needs at the
side bar's minimum width. On a row with a pull request the button covers the glyph's slot, and the
glyph hides while the button shows.

Rows wear the Project tree's Session hover card and context menu, so a Session reads and acts the
same in either body of the side bar. Neither the glyph nor the Project name carries a tooltip of its
own, because a second hover popup on one row would compete with the card. An unread row's menu
leads with **Mark as Read** (Delete's pointer twin, so Archive loses its `delete` hint here).
**Rename** opens the same inline editor as the Project tree, including on an unselected row.

## Interaction

The list is one ARIA tree with a single Tab stop. Group headings are `aria-disabled` tree items
with no Tab stop, because they are derived from Agent state and cannot be collapsed; arrow keys step
over them.

| Input                   | Result                                                         |
| ----------------------- | -------------------------------------------------------------- |
| Click, `Enter`, `Space` | Select that Session; keep a newly viewed row in place          |
| `Up` / `Down`           | Move between Session rows, skipping headings                   |
| `Home` / `End`          | First / last Session row                                       |
| `Delete` / `Backspace`  | Mark the row read, clearing its reminder without opening it    |
| Row's check button      | The pointer equivalent of Delete                               |
| Double-click, Rename    | Edit that Session's title inline                               |
| `session.rename`        | Edit the selected Session's title inline                       |
| Right-click             | The Session context menu, led by Mark as Read when unread      |
| `Cmd+Shift+N`           | Select the next Session needing attention, wrapping at the end |
| `Cmd+Alt+U`             | Switch the side bar between the Project tree and this queue    |

`Delete` clears the reminder here rather than archiving the Session, which is what the same key does
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
Session on the retention clock, purely to preserve a scroll position behind a surface nobody can
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
| `packages/protocol/.../session/session-activity-group.ts`    | Group order, retention window, row order shared with mobile  |
| `.../agent-activity-glyph.ts`                                | Which shape, which words, and the tint a row's state earns   |
| `.../agent-activity-tree.ts`                                 | Flattening and keyboard row math                             |
| `.../use-agent-activity-clock.ts`                            | The subscription to the shared window clock                  |
| `.../agent-activity-view.tsx`, `agent-activity-row-item.tsx` | Rendering, roving focus, and mark-read                       |
| `.../agent-activity-commands.ts`                             | `session.focusNextAttention`                                 |
| `e2e/agent-activity.e2e.ts`                                  | The cross-Project workflow through a real launch             |

Every Session, Project, and Terminal record this list groups is already in the Renderer's bootstrap
store, so nothing here crosses into the Server: the queue is projected client-side, and only the
selection and the read acknowledgement travel over IPC.

The projection groups Terminals by Session once per pass (`sessionTerminalIndex` in
`features/session/session-agent-terminal.ts`) instead of scanning every Terminal for every Session,
so one pass is linear in Sessions plus Terminals and resolves the same Terminal as the single-Session
`sessionAgentTerminal` lookup. It runs only while the queue is mounted, because a hidden queue is
unmounted rather than kept alive. `session.focusNextAttention` computes its own copy from the store
on demand instead of reading the mounted view's, so `Cmd+Shift+N` still works while the queue is
hidden or was never opened.

## Excerpts

A row in the attention group quotes what the Agent last asked
or said so the user can decide whether to open the Session. `agent.excerpts` (read-only, one batch
per view) answers per Session and attention generation: a Chat Agent that is waiting on the user
shows the question or approval it is asking, read from the live Chat's in-memory request without
starting a provider; every other case shows the closing message of the latest turn from the on-disk
transcript. A Terminal Agent has no live request to read, so it only gets the transcript's last
reply. Rows clamp the quote to two lines. The text is user content shown
locally: the Server never persists or logs it, and the Renderer keeps it only in the query cache.

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

This view reports state; it does not schedule work. It does not create Sessions, dispatch Agents,
summarize transcripts (an excerpt is a clipped quote of the Agent's own words, never a summary), or
add event granularity beyond the six `AgentActivityState` values.
[Issue #601](https://github.com/tjx666/caxri/issues/601) tracks a larger butler-window design whose
queue board would reuse this projection.

See [Notifications](notifications.md) for the transient toast and reminder path, and
[GLOSSARY.md](../GLOSSARY.md) for the Agent Activity, Attention, and Unread Attention vocabulary this
view renders.

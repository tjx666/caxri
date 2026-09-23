# Activity view

The Activity view is one of the Primary Side Bar's two bodies. It answers one question across every
Project: **which Sessions are waiting on me right now.** The other body, the Project tree, answers a
different question — which Sessions exist — in the order the user arranged them, so a Session that
needs attention is deliberately never promoted there. Keeping the two orders apart is the point: one
is the user's filing, the other is a queue.

They take turns in the same column rather than sitting side by side. Both describe the same
Sessions, so showing them at once renders every row twice and makes the side bar argue with itself
about what matters. Codex's desktop app and T3 Code both put the queue in the left side bar for the
same reason; Orca keeps the tree and slides a dashboard over it, which still has the two competing
for one column.

Switch with the inbox button in the side bar header, `Cmd+Alt+U`, or the Command Palette entry
**View: Toggle Activity**. It is an inbox rather than a bell because the Status Bar already ends in
a bell with its own unread count, and that one holds app notifications rather than Sessions. The
button carries the number of Sessions with Unread Attention, so the tally is legible while the tree
is showing — which is exactly when the queue is unmounted.
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
| Working           | Its Agent is running, including a compaction turn               |
| Waiting           | Its last Agent Activity was `waiting` and has already been read |
| Failed            | Its last Agent Activity was `failed`                            |
| Recently finished | It completed within the retention window below                  |
| Idle              | Everything else, including a detached Agent that did not fail   |

An empty group is not rendered. Inside a group, rows keep Session activity recency, so the newest
event in a group is always its first row.

Detaching an Agent hands it to another client and stops its Terminal; it does not update the
Session's last Agent Activity, which stays frozen at whatever the final probe recorded. A detached
Session is therefore read as quiet rather than by that frozen value — otherwise one detached
mid-turn would sit under **Waiting** while its own row read "Detached". The one exception is
**Failed**: detaching resolves nothing, and nothing else will clear a failure.

**Attention outranks Working on purpose.** Caxri's unread flag means "something happened that you
have not opened yet", which is a property of the user's queue rather than of the Agent, so it
belongs above any turn still in progress — including that same Session's turn, since a Session can
be both unread and running. herdr and Kero rank their rollups the same way; Orca and T3 Code put
running work first because their lists describe live work rather than a to-do queue.

### Retention

A finished Session stays listed for 15 minutes after its last activity
(`AGENT_ACTIVITY_FINISHED_RETENTION_MS`), then drops out. Without a window, "Recently finished"
would grow into a permanent archive of every Session that ever completed, and the queue would stop
being readable at a glance. A **Failed** Session is deliberately exempt: nothing else will clear it,
so ageing it out would silently lose the only place that failure is reported.

`useAgentActivityClock` subscribes to the same 30-second window clock the relative-time labels use
rather than starting a second timer, so a row's "12m ago" and the window that label is about
turn over in the same tick. It needs no visibility gate: the queue exists only while the side bar is
showing it, so switching back to the tree stops the clock by unmounting its only consumer.

## Visual grammar

A row is a state glyph, the Session title on its own line, and `project · time` beneath it. There is
no state phrase on the row at all:

```text
⊘  Rate limiter for /v1/search
   api-server · 18m ago
```

**The state is a shape because every group heading already names it.** A row under **Working** that
also printed "Working" repeated its own heading, and three of the six groups did exactly that, word
for word. The words are not gone — `agent-activity-glyph.ts` keeps them as the glyph's `aria-label`
and its shared tooltip — they are just no longer spent on a line that has 230px to work with. Orca and
T3 Code reached the same place from a different direction: neither groups by state, and both still
chose a glyph over a colored word because a shape is what a scanning eye resolves first.

Six states, six shapes: a check for a finished turn, a question mark for one waiting on you, a cross
for a failure, a spinner while the Agent runs, a hollow circle for idle, a dashed one when no
activity was ever reported. A detached Agent shows the unplugged glyph instead of its frozen state.

Color is the one thing the shape does not carry, and it still follows the two-tier rule: only
**Needs attention** and **Failed** rows are tinted, so visual weight always means "this one wants
you" and never has to be decoded against a legend. An unread row's tint comes from _why_ it needs
the user (`sessionUnreadTone`), not from what its Agent is doing right now — a completed turn is a
neutral state, which would print the commonest unread row of all in the same grey as an Idle one,
and an unread Session still running is a success state, which would put green under "Needs
attention".

The title takes a line to itself. The Project and time share a fixed-height line below it: when
space runs out, the entire time disappears before the Project truncates. CSS wrapping and clipping
keep this priority independent of text length without measuring in JavaScript or changing the row
height. A Project wider than the entire line still truncates visually; its text remains complete
for assistive technology and its shared tooltip reveals the full name. The Project has priority
because it is the only thing telling the user which repository a row belongs to.

An unread row reserves its mark-read button's width in the title's right padding rather than
surrendering it on hover, so the title never reflows under the pointer.

## Interaction

The list is one ARIA tree with a single Tab stop. Group headings are `aria-disabled` tree items
with no Tab stop, because they are derived from Agent state and cannot be collapsed; arrow keys step
over them.

| Input                   | Result                                                         |
| ----------------------- | -------------------------------------------------------------- |
| Click, `Enter`, `Space` | Select that Session                                            |
| `Up` / `Down`           | Move between Session rows, skipping headings                   |
| `Home` / `End`          | First / last Session row                                       |
| `Delete` / `Backspace`  | Mark the row read, clearing its reminder without opening it    |
| Row's check button      | The pointer equivalent of Delete                               |
| `Cmd+Shift+N`           | Select the next Session needing attention, wrapping at the end |
| `Cmd+Alt+U`             | Switch the side bar between the Project tree and this queue    |

`Delete` clears the reminder here rather than archiving the Session, which is what the same key does
in the Primary Side Bar. The two lists answer different questions, and removing an item from a queue
is what Delete means in a queue.

Switching bodies hands the keyboard over. The body that leaves is unmounted, taking any focused row
with it, and the browser then drops focus onto `document.body` — which silently restarts the next
Tab from the top of the document. `refocusChromeSurfaceBody` in
`apps/desktop/src/renderer/src/stores/chrome-focus-handoff.ts` moves focus to the arriving body's
own entry point instead, but only when focus was inside the side bar to begin with: someone typing
in a Terminal who presses `Cmd+Shift+N` asked to see what is waiting, not to hand over their
keyboard.

### Mode is device state, not Session state

Which body the side bar shows lives in the Renderer's chrome layout
(`primarySidebarActivityMode`), beside the panel widths and visibility flags, and persists to
`localStorage`. It is deliberately not Session-owned: this queue spans every Project, so tying the
mode to the selected Session would flip the side bar's contents underneath a user walking the queue
— the list would vanish on its own first click.

Switching modes unmounts the body that leaves, rather than hiding it. Keeping both alive would mean
a hidden Project tree still polling pull requests, or a hidden queue still re-projecting every
Session on the retention clock, purely to preserve a scroll position behind a surface nobody can
see. The Project tree's own expansion state survives regardless — it lives in its own store, not in
the mounted component.

### `Cmd+Shift+N`, and why not `Cmd+Shift+` backtick

The natural pairing would be the shifted form of Session MRU's `Cmd+` backtick. It is unusable: on a
US macOS layout Shift turns Backquote's printable value into a tilde, so the chord never matches a
stored `cmd+shift+` backtick, and `resolveKeydownBinding`'s unshifted fallback then hands that exact
stroke to `session.switchMru` for reverse cycling.
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
| `.../agent-activity-glyph.ts`                                | Which shape, which words, and the tint a row's state earns   |
| `.../agent-activity-retention.ts`                            | The finished-row window                                      |
| `.../agent-activity-tree.ts`                                 | Flattening and keyboard row math                             |
| `.../use-agent-activity-clock.ts`                            | The subscription to the shared window clock                  |
| `.../agent-activity-view.tsx`, `agent-activity-row-item.tsx` | Rendering, roving focus, and mark-read                       |
| `.../agent-activity-commands.ts`                             | `session.focusNextAttention`                                 |
| `e2e/agent-activity.e2e.ts`                                  | The cross-Project workflow through a real launch             |

Every Session, Project, and Terminal record this list groups is already in the Renderer's bootstrap
store, so nothing here crosses into the Server: the queue is projected client-side, and only the
selection and the read acknowledgement travel over IPC.

## Non-goals

This view reports state; it does not schedule work. It does not create Sessions, dispatch Agents,
summarize transcripts, or add event granularity beyond the six `AgentActivityState` values.
[Issue #601](https://github.com/tjx666/caxri/issues/601) tracks a larger butler-window design whose
queue board would reuse this projection.

See [Notifications](notifications.md) for the transient toast and reminder path, and
[CONTEXT.md](../CONTEXT.md) for the Agent Activity, Attention, and Unread Attention vocabulary this
view renders.

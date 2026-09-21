# Activity view

The Activity view is the Secondary Side Bar container that answers one question across every
Project: **which Sessions are waiting on me right now.** The Primary Side Bar answers a different
question — which Sessions exist — in the order the user arranged them, so a Session that needs
attention is deliberately never promoted there. Keeping the two lists apart is the point: one order
is the user's filing, the other is a queue.

Open it with `Cmd+4`, the Command Palette entry **Secondary Side Bar: Show Activity**, or the
inbox tab in the Secondary Side Bar. `Cmd+Shift+N` jumps straight to the next Session that needs
you without opening anything.

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

Nothing in Server state changes when the window closes, so a hidden Activity container would never
re-read the clock. `useAgentActivityClock` subscribes to the same 30-second window clock the
relative-time labels use rather than starting a second timer, so a row's "12 minutes ago" and the
window that label is about turn over in the same tick; it subscribes only while the container is the
visible tab, because view containers stay mounted once shown.

## Visual grammar

Only **Needs attention** and **Failed** rows get a tinted state chip. Every other state prints the
same phrase in muted text. That two-tier rule is the whole grammar of the list: visual weight always
means "this one wants you", and never has to be decoded against a color legend.

An unread row's tint comes from _why_ it needs the user (`sessionUnreadTone`), not from what its
Agent is doing right now. The Agent's current activity is the wrong input twice over: a completed
turn is a neutral state, which would print the commonest unread row of all in the same grey as an
Idle one, and an unread Session still running is a success state, which would put a green chip under
"Needs attention".

Each row carries the Session title on the first line and its Project, current state, and relative
time on the second. The Project name is not decoration — the list is flat, so without it a row
cannot say which repository it belongs to.

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

`Delete` clears the reminder here rather than archiving the Session, which is what the same key does
in the Primary Side Bar. The two lists answer different questions, and removing an item from a queue
is what Delete means in a queue.

### Selecting keeps the queue on screen

The Secondary Side Bar's visible container is Session-owned state, so selecting another Session
normally restores whatever that Session last showed. For a list whose entire purpose is walking
Sessions, that means the list would disappear on its own first click. `didSelectAgentActivitySession`
re-asserts the Activity container after the selection lands — but only when Activity was already the
visible container _and_ the Secondary Side Bar is actually on screen, so the global `Cmd+Shift+N`
never imposes this view on a user who was looking at Files, and never rewrites a Session's stored
container while the bar is collapsed and nothing on screen could explain it.

Because that container is Session-owned, a Session reached from this queue keeps Activity as its
Secondary Side Bar the next time it is opened — the same way it would keep any container the user
left open on it. Switching that Session to Files or Git replaces it, as usual.

### `Cmd+Shift+N`, and why not `Cmd+Shift+` backtick

The natural pairing would be the shifted form of Session MRU's `Cmd+` backtick. It is unusable: on a
US macOS layout Shift turns Backquote's printable value into a tilde, so the chord never matches a
stored `cmd+shift+` backtick, and `resolveKeydownBinding`'s unshifted fallback then hands that exact
stroke to `session.switchMru` for reverse cycling.
`use-command-shortcuts.test.ts` guards the shipped default set against a future binding that walks
into the same trap.

## Where the code lives

| Path                                                           | Owns                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/protocol/src/registry/core-contributions.ts`         | The `caxri.activity` container, view, command, keybindings   |
| `apps/desktop/.../features/agent-activity/agent-activity-rows` | Grouping, ordering, and the next-attention walk              |
| `.../agent-activity-retention.ts`                              | The finished-row window                                      |
| `.../agent-activity-tree.ts`                                   | Flattening and keyboard row math                             |
| `.../use-agent-activity-clock.ts`                              | The visible-only subscription to the shared window clock     |
| `.../agent-activity-view.tsx`, `agent-activity-row-item.tsx`   | Rendering, roving focus, and mark-read                       |
| `.../agent-activity-commands.ts`                               | `session.focusNextAttention` and container-preserving select |
| `e2e/agent-activity.e2e.ts`                                    | The cross-Project workflow through a real launch             |

The view is a `builtin-react` view rather than a Server-controlled one: every Session, Project, and
Terminal record it groups is already in the Renderer's bootstrap store, so a Server-side provider
would only re-serialize state the client already holds.

## Non-goals

This view reports state; it does not schedule work. It does not create Sessions, dispatch Agents,
summarize transcripts, or add event granularity beyond the six `AgentActivityState` values.
[Issue #601](https://github.com/tjx666/caxri/issues/601) tracks a larger butler-window design whose
queue board would reuse this projection.

See [Notifications](notifications.md) for the transient toast and reminder path, and
[CONTEXT.md](../CONTEXT.md) for the Agent Activity, Attention, and Unread Attention vocabulary this
view renders.

---
kind: living
status: current
---

# Mobile Conversation

The mobile Conversation is a read-only projection of the primary Agent Terminal's own record. The
Server locates and parses the record; the app receives typed timeline items through the encrypted
Mobile gateway. The app does not open provider files or turn Terminal output into messages. Sending
and stopping an Agent remain separate, role-gated commands.

## Answering Agent requests

Claude Code's blocking `PermissionRequest` and `AskUserQuestion` hooks create one Server-owned
request ID per hook invocation only while an eligible `control` device is connected. Otherwise the
native Agent prompt continues immediately. An active hook waits for at most two minutes. `mobile.attention.list`
shows the current request in Conversation; a `control` device can call
`mobile.attention.answer` with that ID. The Server checks the live device generation, role, Session,
and Project grant again before answering. A second answer, a retired Terminal launch, a disconnected
hook, or an expired request is rejected. The hook returns Claude's native decision JSON; it never
writes a guessed key into the PTY. Other providers continue to require Terminal interaction.

Permission cards offer **Allow**, **Deny**, and, for a `control` device only, **Always Allow in
This Session**, the shared approval words from `packages/protocol/src/agent/agent-chat-approval.ts`
scoped to the Session. A device without control access sees no buttons, only how to pair again
with control access. The third action tells the Server to auto-answer every later permission request in
the current Session with `allow`, without waiting for a card or the native prompt; the card states
this in text before the device taps it. The grant covers permission requests only; question
requests are never auto-answered, no matter the Session's grant state, and it applies even while no
phone is online, so a Session left unattended does not stall on the native Claude prompt. The grant
is Server in-memory only and ends when the Session is deleted (not archived) or the Agent Terminal
launch restarts; it is never persisted and never survives a Server restart. A granted Session shows
its status on the mobile card area and on Desktop as an `Always Allow` status bar chip for the
selected Session plus a Session row menu entry; any of them can revoke it immediately; the next request after a revoke goes back to a mobile card, or the native Claude prompt
when no phone is online. Question cards preserve Claude's grouped steps, single or multiple
selections, and free-text answers. A `view` or `reply` device sees a read-only explanation and never
the auto-allow control. The phone polls request status while foregrounded; handled and expired cards
lose their controls. Tool inputs are reduced to a bounded display summary before crossing the hook
socket. No question, command, or answer content enters diagnostics; every auto-allow still logs its
Session, Terminal, and tool name, and every grant/revoke logs its own reason.

## Composer and Project files

`/` suggestions use the running provider's Server-discovered command and skill list; `@` suggestions
use bounded Project file-name search. Selecting an item inserts its invocation or relative path
into the draft. An Agent Chat's composer instead opens Desktop's Chat menu for a draft that is a bare
`/name` or `$name`: the provider's commands under Commands and the Terminal's discovered skills
under Skills, where the skills come from `mobile.agent.actions` with the typed name as `query` so
Server Core ranks the whole list before its 40-action cut. Tapping a command without arguments runs
it; tapping any other row fills the draft with its invocation. See
[Agent Chat](../agent-chat.md) for the full contract. A paired `reply` or `control` device may attach up to three compressed JPEGs from
the library, camera, or clipboard. The app sends bounded chunks through the encrypted gateway;
Server Core writes a file only after all chunks arrive and validates its type and size. The Agent
receives temporary image paths with the submitted prompt. Attachment IDs enter the durable
submission fingerprint alongside the text, so an uncertain retry cannot silently change the
payload. Interrupted uploads expire after two idle minutes without writing a file; completed
temporary images expire after one hour.

The same device may also attach up to ten files of any type, each up to 100 MB: videos from the
photo library, or audio, PDFs, and other documents from the system Files picker (Files). A file
uploads unchanged in `mobile.file.upload` chunks that Server Core writes straight to their offset in
a private temporary file, so a large video never sits in memory whole, and moves into place under
its picked name once every chunk has arrived. The Agent reads it by path: the Terminal composer
lists the paths after the prompt (`fileAttachmentIds` on `mobile.agent.submit`), and an Agent Chat
cites them ahead of the text the way Desktop cites a file card
(`agentChatTextWithPathReferences`), so the sent message and its pending row show them as file
chips. Server Core refuses a Chat message whose text leaves out one of its `files`. For a provider
without Chat image input, photos from the library and camera go as files and the clipboard source
is hidden. Unfinished uploads expire after two idle minutes and uploaded files after one hour; the
composer marks a file older than 55 minutes as expired, and Retry uploads the phone's copy again.

**Session usage.** The Agent Chat composer's model row ends with Desktop's context ring: a quiet
neutral ring until the context reaches the share where compacting is suggested (85% of the window
the provider compacts at), then the warning tone with the percentage. Before the provider reports a
window size, a gauge stands in once the conversation recorded usage. Tapping either opens the
Session usage sheet: the context against that window with the auto-compact note, the conversation's
tokens (input, output, cache read, cache write), estimated cost and models, and the prompt cache's
state (warm with time left, or expired with the estimated rewrite) and hit rate
(`cacheRead / (input + cacheRead + cacheWrite)`). The context and cache clock come from the Chat
snapshot's `usage`; the tokens and cost come from `mobile.agentChat.readUsage`, the same read the
pace reminder and the Session usage sheet's Plan limits use. The context and cost rules
(`agentChatContextUsage`, `agentChatCacheClock`, `agentUsageCostLabel`) live in
`@caxri/protocol`, shared with Desktop's composer meter, Context tab, and status bar chip, so both
Clients show the same figures.

**Context notice.** While no turn runs, one banner above the composer carries Desktop's context
reminders: the prompt cache is about to expire (counting down its last minutes) or has expired with
the estimated rewrite cost, and the context is nearly full (85% of the compaction limit). Which
notices show comes from `agentChatContextAlertsState` in `@caxri/protocol`, the function Desktop's
composer words differently, so both Clients raise the same conditions. Usage opens the Session usage
sheet; Dismiss hides the cache line until the next reply restarts the cache, while the full-context
line stays. Unlike Desktop, the phone does not know the Server's idle-compaction setting, so it
never shows the "auto-compacts in" state and counts down to the expiry instead, and its dismissal
is kept in memory per app run rather than shared with Desktop (Desktop's is also memory-only).

The Project file preview exposes **Edit** only to `control` devices for bounded editable text.
`mobile.files.write` carries the hash of the content originally read. The existing document writer
checks that precondition inside its ordered, atomic save path and rejects an external change with
`CONFLICT`; the mobile editor offers Discard and reload. Workspace symlinks retain their entry-path
identity and use the Desktop document service's existing authorization rules.

## Authority and projection

`mobile.timeline.read({ sessionId, before?, limit? })` requires a current paired device and a
Session in one of its granted Projects. The gateway checks the live device generation, role, and
Project grants around the Server read. Server Core checks the paired principal and Session again
before selecting that Session's primary Agent Terminal. A denied Session is an authorization error,
not an empty timeline.

The projection currently supports every Agent provider whose descriptor registers a
`timelineProjector` (Claude Code and Codex today); a provider without one, such as Grok Build, reports
`unsupported` instead of a partial or guessed timeline. It emits chronological `userMessage`,
`agentMessage`, `toolCall`, `turnBoundary`, and `systemEvent` items with stable IDs. Tool items have
a bounded name, summary, status, optional duration, and optional detail. A `turnBoundary` carries an
optional duration and an optional closed `outcome` (`completed`, `interrupted`, or `failed`) when the
record states how the turn ended; Codex's `turn_aborted` maps to `interrupted`. The phone labels the
divider with Agent Chat's turn wording (`Worked for 4s`, `Stopped after 4s`, `Failed`), and a
boundary without an outcome reads as completed. Thinking and unrelated
provider records are excluded. A successful read returns one of these statuses:

| Status        | Meaning                                                                 | Mobile behavior                         |
| ------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `available`   | A supported Agent record was opened, including an empty record.         | Render Conversation.                    |
| `unsupported` | The primary Agent uses a provider without a timeline projection.        | Show the explanation and open Terminal. |
| `missing`     | The Session has no primary Agent record, or it cannot be opened safely. | Show the explanation and open Terminal. |

### System events

A provider CLI sometimes writes harness-injected content into what is otherwise a user turn instead
of text the reader typed: a background task notification, a `/command` echo (with its local stdout
and any caveat), a `!`-prefixed bash-mode echo, or a standalone caveat. The Server recognizes these
by their tags (`<task-notification>`, `<command-name>`/`<command-message>`, `<bash-input>`,
`<local-command-caveat>`) and projects them as a `systemEvent` item (`kind` is one of
`taskNotification`, `slashCommand`, `bashCommand`, or `caveat`) instead of a raw `userMessage`, so
the mobile reader sees "ran `/compact`" rather than the literal envelope. A turn made of only a
`<system-reminder>` block is not classified into any kind; it is stripped to empty text upstream and
the empty item is dropped, so it never reaches the timeline at all.

The Server reads a bounded transcript window and returns at most 80 items and roughly 48 KiB per
page. The default page limit is 40. Individual message text is limited to 4,096 characters and
tool detail to 2,048 characters. `olderCursor` requests an earlier page. `truncated` means the
retained window does not include the beginning of the record; the app tells the reader that earlier
messages are available on the computer. The Server retains at most 16 MiB of parsed source in its
cache and initially reads only the latest 4 MiB, so this view is not a complete archive.
Reads are serialized per Terminal, including cache updates and source-revision assignment. Two
devices therefore cannot append the same record twice or publish inconsistent cursor generations.
Forgetting a Terminal invalidates pending reads so they cannot repopulate its retired cache.

Cursors encode source identity, byte position, and item position within a provider record.
Rotation, shrinkage, or a detected same-file rewrite creates a new source generation. A cursor
from another generation expires. The response sets `cursorExpired` and starts again from
the current latest page; the app replaces stale history instead of joining items from two source
generations. Item IDs also incorporate source identity and position. A valid cursor outside the
cached window triggers bounded older-file reads. When one provider record projects multiple items,
those reads include the cursor's record so earlier items from that same record remain reachable.

## Updates and rendering

While Conversation is visible in the foreground, the app subscribes to that Session's
`conversation.changed` invalidations. The event contains no message or tool content. The app
subscribes before its initial snapshot, serializes reads, and refreshes again if an event arrives
during a read. If subscription is unavailable, it polls while visible every 2.5 seconds. Background,
unmount, disconnect, and revocation end the active observation. Reconnect obtains a fresh snapshot;
the last visible items are marked stale until then. Before the first snapshot, a Conversation or
Chat opened earlier shows the trimmed copy the phone saved in its
[read cache](design.md#read-cache), labeled with its age; the first live snapshot replaces it.

Latest-page updates replace the overlapping suffix without replacing the pagination cursor of
the oldest retained item. Once earlier pages are loaded, live updates therefore preserve progress
toward the beginning, including the exhausted-history state. A disjoint latest page replaces both
the retained items and their pagination cursor.

The app renders Agent messages as native Markdown without remote images, user messages as bubbles,
consecutive tools as collapsible groups, and turn boundaries with duration when present. A tool
row opens its bounded detail. The virtualized list loads older pages and follows new content only
when the reader is near the bottom; otherwise it offers **Jump to latest**. Following is the list's
own (`createConversationFollower` in `conversation-scroll.ts`), not FlashList's autoscroll: a drag
stops following at once, content that changes during a drag or its momentum never scrolls under
the finger, and only the reader's touch can leave the end, so a scroll event that lags behind new
content does not. Only a momentum that follows the reader's drag counts as touch: Android also
reports an animated programmatic scroll such as Jump to latest as momentum. When the touch settles near the end after content changed, the list catches up
once; scrolls requested within one frame collapse into one. An Agent Chat also pins its latest
sent message to the top of the viewport; see [Agent Chat: Mobile](../agent-chat.md#mobile). Loading, empty, error,
and stale states remain visible. `unsupported` and `missing` automatically select the Terminal
with an explanation. The reader may also select Terminal directly.

An Agent Chat reuses this list. Its user messages draw their images as a right-aligned strip of
thumbnails above the bubble, and a tap opens the original full screen with pinch, pan, and
double-tap zoom. Both are fetched on demand; see [Agent Chat: Mobile](../agent-chat.md#mobile).

Conversation content and tool detail can contain sensitive material from the Agent record. They
are returned only to a currently authorized paired device over the encrypted gateway; transcript
bytes are not included in invalidation events, diagnostic logs, or durable recovery events. The
projection bounds content for transport and display; it is not a redaction or secret-filtering
feature.

## Implementation references

- [Timeline contract](../../packages/protocol/src/mobile/mobile-contract.ts)
- [Gateway authorization](../../apps/server/src/core/mobile/access-controller.ts) and
  [Server read](../../apps/server/src/domains/mobile/handlers.ts)
- [Timeline projection](../../apps/server/src/domains/agents/timeline.ts),
  [Claude parser](../../apps/server/src/domains/agents/providers/claude/timeline.ts), and
  [Codex parser](../../apps/server/src/domains/agents/providers/codex/timeline.ts)
- [System event classification](../../apps/server/src/domains/agents/system-event.ts)
- [Transcript watcher](../../apps/server/src/domains/agents/transcript-watcher.ts) and
  [mobile observer](../../apps/mobile/src/features/conversation/use-conversation-timeline.ts)
- [Conversation UI](../../apps/mobile/src/features/conversation/conversation-view.tsx)

See [Mobile transport](transport.md) for gateway framing, subscription lifecycle, and limits, and
[Mobile design](design.md#conversation) for the intended interaction contract.

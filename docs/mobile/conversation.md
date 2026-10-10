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

Permission cards offer **Allow once**, **Deny**, and, for a `control` device only, **Always allow in
this Session**. The third action tells the Server to auto-answer every later permission request in
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
into the draft. A paired `reply` or `control` device may attach up to three compressed JPEGs from
the library, camera, or clipboard. The app sends bounded chunks through the encrypted gateway;
Server Core writes a file only after all chunks arrive and validates its type and size. The Agent
receives temporary image paths with the submitted prompt. Attachment IDs enter the durable
submission fingerprint alongside the text, so an uncertain retry cannot silently change the
payload. Interrupted uploads expire after two idle minutes without writing a file; completed
temporary images expire after one hour.

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
a bounded name, summary, status, optional duration, and optional detail. Thinking and unrelated
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
the last visible items are marked stale until then.

Latest-page updates replace the overlapping suffix without replacing the pagination cursor of
the oldest retained item. Once earlier pages are loaded, live updates therefore preserve progress
toward the beginning, including the exhausted-history state. A disjoint latest page replaces both
the retained items and their pagination cursor.

The app renders Agent messages as native Markdown without remote images, user messages as bubbles,
consecutive tools as collapsible groups, and turn boundaries with duration when present. A tool
row opens its bounded detail. The virtualized list loads older pages and follows new content only
when the reader is near the bottom; otherwise it offers **Jump to latest**. Loading, empty, error,
and stale states remain visible. `unsupported` and `missing` automatically select the Terminal
with an explanation. The reader may also select Terminal directly.

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

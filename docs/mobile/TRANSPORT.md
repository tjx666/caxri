# Mobile transport

The Mobile gateway is a separate, default-off WebSocket endpoint on a private IPv4 address. Pairing
and reconnect use the versioned encrypted handshake in `@caxri/mobile-transport`. Version 3 adds
Terminal observer snapshots, Host output sequences, and generation-fenced control. A mismatched `hello` receives a plaintext
`version-mismatch` frame before authentication; all application frames after authentication are
sealed with the session key and monotonically increasing counters.

## Application frames

The shared transport package validates each outer frame. `request.request` and `reply.reply` are
then validated by the protocol package at their respective endpoints. They keep the existing
`CommandRequestEnvelope` and `CommandReplyEnvelope`; `reply.reply.id` is the single correlation key
for commands, subscribe, and unsubscribe.

| Direction       | Frame                                                                             | Meaning                                                             |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Client → Server | `request {request}`                                                               | Invoke one authorized command.                                      |
| Client → Server | `subscribe {id,resource}`                                                         | Create a subscription; reply result is `{subscriptionId}`.          |
| Client → Server | `unsubscribe {id,subscriptionId}`                                                 | Remove a subscription; reply result is `{}`.                        |
| Client → Server | `heartbeat {nonce}`                                                               | Probe the authenticated connection.                                 |
| Server → Client | `reply {reply}`                                                                   | Command or subscription acknowledgement, including protocol errors. |
| Server → Client | `event {subscriptionId,sequence,kind}`                                            | Content-free invalidation or resync notice.                         |
| Server → Client | `stream {subscriptionId,sequence,kind,generation,chunkIndex,chunkCount,chunkHex}` | Terminal snapshot or live output chunks.                            |
| Server → Client | `heartbeat-ack {nonce}`                                                           | Echo the client's probe nonce.                                      |
| Server → Client | `revoked`                                                                         | Final encrypted revocation notice, followed by close.               |

Resources are `{kind:'dashboard'}`, `{kind:'conversation',sessionId}`, and
`{kind:'terminal',terminalId}`. The Server chooses opaque subscription IDs. `sequence` starts at
zero for each subscription and increases across both `event` and `stream`. Dashboard and
conversation events use `dashboard.changed` and `conversation.changed`; they carry no Session,
Project, transcript, or Terminal content. Clients re-query an authoritative snapshot after a hint.
Terminal snapshots are UTF-8 JSON of `TerminalSnapshot|null`; output is UTF-8 text. Both split into
at most 24 KiB of raw bytes per `chunkHex` frame. A subscribe reply is sent before the first
snapshot chunk. Snapshot chunks carry `nextHostSequence`; output chunks carry `hostSequence`.
The client assembles a snapshot before applying later output. Each Terminal subscription has its
own wire sequence, while Host sequence and generation detect source loss or Terminal restart.

Every WebView document-ready event retires the previous observer and requests a new snapshot.
Observer cleanup also drops pending native-to-WebView output. Snapshot replacement queues a hard
reset in xterm's input stream after sizing the grid, so old asynchronous parser writes cannot
appear on the replacement screen. Android recreates the native WebView when its renderer exits.

## Authority and lifecycle

Server Core checks the live device generation, exact role, and Project grant for every command and
subscription. A dashboard subscription requires `mobile.dashboard`; a Terminal subscription
requires `terminal.preview` and an authorized Terminal; a conversation subscription requires an
authorized Session. Every push checks the current grant and resource again. A changed or revoked
grant cannot turn an old connection into broader access. Revocation closes the socket and removes
all subscriptions; close and gateway disable also clear them. Terminal subscriptions use the Host
observer API, never Desktop attachment. Each Terminal is subscribed at most once per socket and
at most four Terminal observers are retained per socket. Host gaps, generation changes, and Host
exit send `resync-required` and end the affected subscription.

The gateway serializes decrypt and replay-counter checks, then dispatches up to eight commands or
subscription operations per socket concurrently. A slow command cannot block heartbeat or another
reply. Outbound sealing assigns counters on one synchronous path, preserving replay order even when
command replies finish out of order. Before sending a completed operation, the gateway rechecks
that the same authenticated device and generation are still active.

The client sends a heartbeat every three seconds while foregrounded and treats a missing answer
after five seconds as a connection failure. The Server closes a socket after 12 seconds without a
valid authenticated client frame. The client considers its view stale after five seconds without a
valid authenticated Server observation, retains the last snapshot, and disables mutations until
fresh data arrives. On reconnect, a visible view subscribes first and then queries its snapshot;
an event arriving during that query triggers another refresh. Background or unmounted views
unsubscribe. A push can reach the socket before its subscribe reply; the client buffers a bounded
number of such frames by subscription ID and replays them when the reply installs the listener.
An early `resync-required` takes precedence over an acknowledgement and restarts subscription and
snapshot recovery.

An authenticated foreground heartbeat also renews any Terminal size lease held by that exact
connection and subscription. The Host restores Desktop's latest desired size on unsubscribe,
socket close, revocation, release, or its independent 12-second lease timeout. Only an explicit
`mobile.terminal.takeOver` request can alter the PTY size; `mobile.terminal.release` returns size
ownership to Desktop. `mobile.terminal.input` is fenced to the observed Terminal generation.
Terminal Host publishes `terminal.sizeOwnership` with the owner and actual PTY grid on takeover,
mobile size changes, release, timeout, and Desktop attachment. Server Core filters stale Host
generations before relaying the event. Desktop keeps xterm at the mobile-owned grid while reporting
its latest fitted grid for restoration. The ownership event is transient: a late or reconnected
Desktop receives current state from its new attachment instead of replaying an expired lease.

## Backpressure and privacy

Each socket has a bounded inbound frame queue and at most 32 subscriptions. Outbound queues have
both per-subscription and per-socket byte limits, so duplicate subscriptions cannot multiply one
slow socket's backlog without bound. When a queue overflows, the Server
sends one `resync-required` event with `reason:'capacity'`, removes that subscription, and expects
the client to subscribe and query again. One slow subscription does not delay another. If the
socket itself cannot accept a sealed frame, the Server ends that socket for recovery.
Snapshot chunks are sent one completed WebSocket write at a time, so a normal 2 MiB snapshot
does not consume the queued output budget. Host output buffered behind a snapshot remains bounded
per subscription and per socket. A Host source gap uses `reason:'source-gap'`; a restart or lost
Host uses `reason:'generation-changed'`.

Dashboard and conversation hints must remain content-free. Terminal bytes go only to a currently
authorized Terminal subscription and never enter the durable recovery journal or diagnostic logs.
The gateway validates resource scope before each push, including after a same-host re-pair changes
Project grants. Live Terminal observation and size ownership are governed by the separate Terminal
observer contract; mobile transport does not resize Desktop's Terminal by subscribing.

The [Conversation guide](CONVERSATION.md) covers the authorized timeline snapshot, cursor recovery,
and native mobile rendering behind the content-free hints.
The [Changes guide](CHANGES.md) covers authorized Git snapshots, bounded diffs, and the
content-free `changes.changed` hint.

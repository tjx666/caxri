# Agent Endpoints, messaging, dispatch, and steering

Each managed Agent generation receives an independent, short-lived Agent Endpoint ref and token after Server
Core has resolved its Project, Session, Terminal, provider, and launch configuration. Terminal Host exposes a
mode-`0600` private Unix socket and gives the Shell only a one-time launcher capability. A fixed launcher
claims that capability before user startup files run, receives structured executable, argv, cwd, and filtered
environment fields, removes the capability from the Shell environment, and waits for the Agent child. Endpoint
credentials and the managed hook token exist only in that child plan. The long-lived Shell carries a separate
observation-only hook token; it has no Agent Endpoint or managed-process control authority, and its signals remain
inactive while the managed child owns the current hook generation. Agent
start and exit events carry the exact launch ID so stale generations cannot activate credentials, settle a
newer dispatch, or receive control signals. Server Core never persists a token or publishes it through events,
diagnostics, snapshots, or command output. Provider launch evidence classifies only the built-in executable
with an empty argument list as `standard`, exact documented bypass flags as `elevated`, and custom executables
or arguments as `unknown`. Endpoint selectors use the opaque ref; duplicate display names never redirect a
mutation to a newer generation.

Peer messages are Server Core-owned, generation-scoped, bounded plain text. Their bodies exist only in the
live in-memory Inbox and never enter SQLite, logs, diagnostics, the event journal, Terminal
snapshots, or PTY input. `auto` accepts only same-Project peers whose known permission classes match;
otherwise the receiver's `accept`, `hold`, or `refuse` policy decides. Waiting and held queues are
bounded independently, and expiration or either Endpoint generation ending destroys every undelivered
body. A pull stays reserved until the authenticated local socket flushes its response; disconnecting
before that boundary requeues the message at the FIFO front. The held-message list and event contain
only a bounded preview; Desktop fetches the selected full in-memory body on demand and cannot approve
until that fetch succeeds. Approval moves only one held message into the receiver Inbox. Peer text
carries `origin: peer` and can never grant a permission,
change settings, invoke a slash command, wake an Agent, or write a user prompt.

Agent dispatch/control and human Terminal steer are separate command domains rather than Peer Inbox
fallbacks. A default Agent Endpoint can read same-Project dispatch receipts, but `agent:control` is a
bounded generation grant that adds `agents.dispatch` and `agents.control` for that Project only.
Server Core persists a dispatch receipt before a fresh Terminal or resumed managed Agent can spawn, fences
resume to the Terminal's exact provider session binding, and reports lifecycle changes from managed Agent
process events without reading output or silence. Server Core and Terminal Host both revalidate the exact
launch ID before an interrupt or stop reaches the current Caxri-owned Agent child; control never targets the
long-lived Shell root. A client disconnect explicitly cancels its dispatch long poll.

Managed launch failure, interruption causes, and content-free transition logs are documented in
[Agent dispatch receipts](../../../../docs/agent-dispatch-receipts.md).

`terminal.send` requires a Desktop or human CLI owner with `terminals.steer`, or a paired device using
the narrower `mobileAccess.invokeShortReply` path. The paired-device path rechecks its current pairing,
Project scope, selected waiting Agent, and attention epoch and accepts only a bounded plain-text reply.
Owner CLI text is bounded by UTF-8 bytes, rejects C0/C1 controls except Tab, and adds Enter only through
the explicit flag. Terminal steer shares content-free PTY input metrics and logs only target, byte count,
Enter state, and principal kind;
it never claims peer origin. Explicit message `--wake` requires both dispatch and control authority,
resumes only a bounded tombstone for the exact stopped generation, confirms the replacement Endpoint,
then admits the message under the same request identity. See `docs/agent-command-authority.md`.

Each Endpoint also exposes one typed messaging capability (`deliveryMode`, `health`, stable `reason`,
`checkedAt`, and `nextAction`). The Server Core probes the configured executable and version behind a
bounded cache; disabling the integration or invalidating the probe revokes messaging without stopping
the PTY. Unknown future Provider majors fail closed. The verified stable matrix is Claude Code
2.1.80+ within major 2 and Codex 0.147.0+ within major 0, both using `pull` through the version-matched
Caxri CLI. Claude custom Channels preserve a non-user source, but remain a research preview that
requires `--dangerously-load-development-channels`; Caxri therefore does not enable that flag or
advertise stable push. A future allowlisted Channel adapter must omit the independent
`claude/channel/permission` capability and acknowledge only after its exact transport delivery.
See [Claude Code Channels](https://code.claude.com/docs/en/channels) and the
[Channels reference](https://code.claude.com/docs/en/channels-reference). Codex 0.147.0 exposes no
documented peer-origin push boundary, so Caxri never guesses app-server frames or Provider storage.
Pull `wait` and `check` consume only after the authenticated Server Core reply flushes; timeout, cancellation,
or disconnect requeues the same FIFO message. The controlled version matrix and operator behavior
are recorded in `docs/provider-messaging.md`.

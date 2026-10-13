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
long-lived Shell root. A client disconnect explicitly cancels its dispatch long poll. A Chat Terminal target
has no child process to signal: `terminal.sendInternal`, interrupt, stop, and dispatch `resume`/`wake` drive it
through `AgentChatService` (`agent-dispatch/chat-target.ts`, `chat-launch.ts`), and its process state reaches
receipts through `AgentChatServiceOptions.onAgentStateChanged`; dispatch `start` still creates a PTY.

The Agent Commander Endpoint is the one fixed exception to grant-only delegation. Domain services begin
it with `role: 'commander'`, which adds `commander` and `agents.delegate` while its Project scope stays
the Commander's system Project. Server Core defers the delegation target check for that principal to the
delegation domain, which admits only the exact recorded Commander Terminal delegating into a non-archived
Session it created through `commander.session.create` in a visible top-level Project. It never gains
dispatch, control, steer, or Settings write authority. See `docs/agent-commander.md`.

A delegation completion notice pushed into the Commander Terminal (`CommanderCompletionNotifier`,
`apps/server/src/domains/commander/completion-notice.ts`) is a second, narrow exception, distinct
from the Commander delegation-target exception above and never a relaxation of the peer-message rule:
it does not use the Peer Inbox at all, has no sender Endpoint, and never carries Agent-authored text:
only Server-generated fields (a delegation ID, a Session ID, a closed status word) in one bounded
line, exactly like the content-free PTY input metrics Terminal steer already logs. Like peer text, it
can never grant a permission, change a setting, invoke a slash command, or write a user prompt; unlike
peer text, its point is to make the Commander act, so it deliberately does reach an idle Commander's
PTY input rather than waiting in an Inbox. Delivery is fenced to the exact idle-proof-and-input-epoch
check `AgentDelegationService` already uses before resuming a follow-up, so a draft the human is
composing defers it the same way a follow-up defers. Undelivered notices persist in
`commander_pending_notices`; a relaunched Commander, which has no finished turn to prove idle, receives
them (and a marker for a turn a restart cut off) as its launch prompt instead. See "Completion
notices" in `docs/agent-commander.md`.

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
`checkedAt`, and `nextAction`), capability-detected behind a bounded probe cache; disabling the
integration or invalidating the probe revokes messaging without stopping the PTY, and unknown future
Provider majors fail closed. The verified controlled version matrix, Claude Channels' research-preview
boundary, and pull/FIFO delivery semantics are Server Core-agnostic product behavior owned by
[Provider messaging support](../../../../docs/provider-messaging.md): read it instead of re-deriving
version numbers here, since a second copy is how they drift.

---
kind: living
status: current
---

# Agent Chat

A Chat is an Agent Terminal created with the `chat` surface. It runs the user's own, unmodified
Agent CLI through the vendor's structured protocol and renders a conversation (streamed Markdown,
collapsible tool rows, approval and question cards) instead of a terminal grid. The decision and
its trade-offs are in [ADR 0012](adr/0012-agent-chat-surface.md).

Codex is the only Chat-capable provider today (`capabilities.chat` in the provider catalog,
`packages/protocol/src/agent/agents.ts`). Claude Code will follow through the Claude Agent SDK;
Grok Build stays PTY-only.

## Surface and identity

- `terminal.create` takes `surface: 'chat'`; the default is a PTY. The surface is stored in the
  `terminals.surface` column and never changes after creation. `isChatTerminal` is the one
  predicate every surface-dependent path checks.
- A Chat keeps everything else a Terminal owns: its Session, Primary Agent election, naming, pane
  placement, and the `terminal` pane resource.
- The Agent Session (the Codex thread id) is bound to the Terminal only when the thread's first
  turn starts. Codex writes no rollout before that, so an earlier binding could never be resumed.
  An unbound Chat simply opens a new thread on its next start.
- PTY-only operations (Terminal input from other Clients, Agent dispatch, compaction, Git review
  sends, long pastes, mobile submits, suspension, restore) reject or skip a Chat through
  `apps/server/src/domains/terminal/pty-guard.ts` before any side effect.

## Process lifecycle

`AgentChatService` (`apps/server/src/domains/agent-chat/service.ts`) owns one
`codex app-server --listen stdio://` child per live Chat, spawned by Server Core with the same
allowlisted environment as other Agent launches and no lifecycle-hook environment (the Chat
synthesizes its own lifecycle signals, so hooks would double-report).

- **Lazy start.** The provider starts on the first `agentChat.read` or `agentChat.send`. Server
  Core restart therefore never relaunches idle Chats, and boot-time Terminal restore skips them.
- **Resume.** A bound Chat resumes its thread with `thread/resume`, verifies the returned id, and
  rebuilds the projection from the returned history. `model` is omitted on resume so the thread
  keeps its own model and effort. A failed resume is a visible `resume_failed` failure, never a
  silent new thread.
- **Stop.** Closing, deleting, archiving, or detaching the Session stops the child (stdin EOF, then
  SIGTERM and SIGKILL on its process group). `terminal.restart` restarts it; a fresh restart drops
  the thread binding first. A failed Chat stays failed on read; the pane's Retry restarts it, which
  clears the failure and resumes the bound thread.
- **State.** `lastProcessState` and `lastAgentProcessState` follow the child: `starting`,
  `running`, `stopped` after an orderly stop, `dead` after an unexpected exit, `failed` with a
  closed `failureReason` when it cannot start. Orderly Server Core shutdown stamps `interrupted`
  through the shared shutdown path, not completion.
- **Idle exit.** Live Chat children count toward `activePtyCount`, so Server Core idle exit and
  `server.stop` treat them like live PTYs.

## Launch settings

The Codex launch settings configured for the TUI are translated, not appended
(`apps/server/src/domains/agent-chat/launch-settings.ts`):

| TUI argument                                 | Chat equivalent                                          |
| -------------------------------------------- | -------------------------------------------------------- |
| `--dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`, `sandbox: danger-full-access`   |
| (absent)                                     | `approvalPolicy: on-request`, `sandbox: workspace-write` |
| `--model`, `--sandbox`, `--ask-for-approval` | The thread field of the same meaning                     |
| `--config`, `--profile`                      | Kept as root options before `app-server`                 |
| Anything else (`--search`, UI flags)         | Dropped: it has no meaning outside the TUI               |

## Projection and streaming

Server Core keeps a bounded, in-memory projection per Chat (`AgentChatSnapshot` in
`packages/protocol/src/agent/agent-chat-contract.ts`): items, turns, the active turn, pending
requests, the plan, model, and token usage. It is never persisted or logged; the provider's own
record is the source of truth.

- `agentChat.read` returns the snapshot. Updates arrive as the transient `agentChat.patch` event,
  which never enters the durable journal. Deltas are coalesced into one patch per 16 ms window.
- Every patch carries `baseRevision` and `revision`. Server Core and every Client apply operations
  with the same reducer (`packages/protocol/src/agent/agent-chat-reducer.ts`); a Client whose
  revision does not match re-reads. Server Core flushes queued operations before each read so a
  snapshot never contains an operation a later patch would repeat. A restart or close drops the projection
  but never reuses a revision: the replacement starts one past the last revision, so a Client
  holding the old snapshot sees a gap and re-reads instead of discarding new patches.
- Bounds: 1,000 items, 64 KiB per message, 16 KiB of command output (the tail is kept), 64 KiB per
  diff, and a 4 MiB aggregate text budget. Older items are dropped first and `truncated` is set.
- Items a turn left open (an interrupted command, a cut-off message) are closed as `interrupted`
  when the turn ends or the process exits.

## Approvals and questions

Codex server requests become pending `requests` keyed by the approval callback id when present,
else the item id. Codex re-sends pending requests with fresh transport ids after a resume, and
several callbacks can share one item, so the transport id is never the key.

- `agentChat.respond` answers one request; a request that is no longer pending fails with
  `CONFLICT`. Approvals take a decision (`accept`, `acceptForSession`, `decline`, `cancel`);
  questions take answers per question id.
- Requests Caxri cannot render are answered immediately (MCP elicitation is declined, anything
  else gets a JSON-RPC error) so the turn never blocks on a request no one can see.
- Each pending request raises Attention through a synthesized `attentionRequested` signal and
  clears it with `attentionResolved`, so Activity and the Primary Sidebar behave as for a PTY.

## Lifecycle signals

A Chat begins its own launch generation with the Agent coordinator and synthesizes
`sessionIdentified`, `turnStarted`, `turnFinished`, `turnFailed`, `attentionRequested`, and
`attentionResolved` from protocol events. They take the same provenance path as authenticated
hook signals, but they do not depend on the provider's hooks setting. The coordinator skips
working-directory session discovery for an unbound Chat so it cannot claim an unrelated PTY
conversation.

## Observability

`agent_chat.process_started` (closed outcome and reason, resume mode, duration),
`agent_chat.process_exited` (closed end reason with lifetime aggregates of turns, server
requests, rejected requests, and dropped frames), `agent_chat.turn_finished` (status, duration),
and `agent_chat.protocol_rejected` (closed reason, protocol method name). None of them carries
message text, command output, provider stderr, or protocol bodies.

## Testing

`apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-app-server.mjs` is a
deterministic stand-in for the app-server, selected by keywords in the user's message (approval,
question, slow stream, failure, crash). Unit and integration tests drive it; no test launches the
real CLI or calls a model, and real-Agent E2E refuses to start a Chat.

## Not yet supported

Switching an existing Terminal between surfaces, Chat on mobile, image input, slash commands, and
the Claude Agent SDK provider.

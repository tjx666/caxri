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
- `session.create` takes the same optional `surface`, so a new Session can start with a Chat as its
  first Terminal. Server Core refuses a Chat for an Agent without `capabilities.chat` before writing
  anything (`canUseAgentChat`).
- Users choose the surface through one setting, `session.openAgentsInChat` (Settings, or the
  "Open in Chat" toggle at the foot of the New Session and New Terminal menus and the centered
  Agent-choice dialog). Each menu lists every Agent once; with the toggle on, Chat-capable rows show
  a muted "Chat" marker. Direct creation with a default Agent and `Cmd+T` follow the setting too,
  while a click on the tab strip's `+` clones the primary Agent Terminal on its own surface.
- A Chat keeps everything else a Terminal owns: its Session, Primary Agent election, naming, pane
  placement, and the `terminal` pane resource.
- The Agent Session (the Codex thread id) is bound to the Terminal only when the thread's first
  turn starts. Codex writes no rollout before that, so an earlier binding could never be resumed.
  An unbound Chat simply opens a new thread on its next start.
- PTY-only operations (Terminal input from other Clients, Agent dispatch, compaction, Git review
  sends, long pastes, mobile submits, suspension, restore) reject or skip a Chat through
  `apps/server/src/domains/pty-guard.ts` before any side effect.

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
- **Running count.** Live Chat children count toward `activePtyCount` and `terminal.runningCount`
  (whole app or one Session), so Server Core idle exit, `server.stop`, the window-close
  confirmation, and Session or Project deletion prompts treat them like live PTYs. Choosing
  Terminate and Close stops the Chat provider process with the PTYs.

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
  diff, 1 MiB of diffs per file-change item, and a 4 MiB aggregate text budget. The budget also holds
  while a reply streams. Older items are dropped first and `truncated` is set.
- A Client that receives a patch while its own read is still in flight holds the patch (up to 200)
  and replays it once the read lands, instead of dropping it and re-reading again.
- The stdio connection frames Codex output by bytes, rejects an oversized frame before parsing
  it, and stops a provider whose stdin backlog passes 8 MiB rather than buffering without bound.
- Items a turn left open (an interrupted command, a cut-off message) are closed as `interrupted`
  when the turn ends or the process exits.

## Approvals and questions

Codex server requests become pending `requests` keyed by the approval callback id when present,
else the item id. Codex re-sends pending requests with fresh transport ids after a resume, and
several callbacks can share one item, so the transport id is never the key.

- `agentChat.respond` answers one request; a request that is no longer pending fails with
  `CONFLICT`. Approvals take a decision (`accept`, `acceptForSession`, `decline`, `cancel`);
  questions take answers per question id. Skip answers a question with no answers, which Codex
  reads as "no answer"; any other decision for a question is rejected.
- Approval cards show what is being approved: the command and its working directory (relative to the
  Project, hidden at its root), the network host for a network approval, the files a file-change
  approval would touch, and Codex's stated reason. Only the decisions Codex lists in
  `availableDecisions` are offered. Controls stay disabled while an answer is in flight.
- An answered question leaves an `answered` notice in the timeline, so the transcript records what
  the user chose after the card disappears.
- Requests Caxri cannot render are answered immediately (MCP elicitation is declined, anything
  else gets a JSON-RPC error) so the turn never blocks on a request no one can see.
- Each pending request raises Attention through a synthesized `attentionRequested` signal and
  clears it with `attentionResolved`, so Activity and the Primary Sidebar behave as for a PTY.

## Pane

- The transcript and the composer share one centered column. Pending approvals, questions, the
  plan, and the failure banner sit in a dock above the composer, outside the scroller, so reading
  history never hides them. The timeline follows new output until the user scrolls up; Jump to
  latest returns to the end.
- The composer keeps an unsent draft per Chat across tab switches, clears only the text that was
  actually sent, and treats Escape as Stop while a turn runs. Its footer shows the model and the
  remaining context window.
- Replies render Markdown through the shared `@caxri/markdown` block tree
  ([`components/markdown/`](../apps/desktop/src/renderer/src/components/markdown/markdown-blocks.tsx)):
  leveled headings, nested and task lists, quotes, tables with Copy table (Markdown plus HTML), and
  fenced code with a header (language, word-wrap toggle, Copy code) painted by Monaco's colorizer
  once the fence closes. A reply offers Copy message on hover after it finishes.
- While a reply streams, `repairStreamingMarkdown` completes the last block's unfinished emphasis,
  inline code, and links so raw syntax never flashes, and blocks are memoized by value so a delta
  re-renders only the block it changed.
- A file path the Agent cites in inline code or a link (a `path:line` code span, or a link whose destination is a relative path with an optional `#L` anchor)
  opens in the editor through the same resolver and Project candidate picker as a Terminal file
  link.

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

`apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-app-server.ts` is a
deterministic stand-in for the app-server, selected by keywords in the user's message (approval,
question, table, slow stream, failure, crash). Unit and integration tests drive it; no test launches the
real CLI or calls a model.

`bun run test:e2e:real-agent` is the manual, never-CI smoke against the real CLI (see the `e2e-testing` skill). Its
Chat case runs under a real-Agent policy authorized for the Chat surface only: that run cannot open a PTY or Shell
Terminal, and the thread is pinned to a read-only sandbox with no approvals, ignoring the user's Codex launch
settings. It sends two short natural prompts, relaunches Caxri between them, and asserts only content-free signals:
Chat status, turn statuses, item counts by type, an unchanged `agentSessionId`, and the `agent_chat.process_started`
modes (`started`, then `resumed`) and `agent_chat.turn_finished` statuses from the Server Core log. It never reads,
logs, or captures reply text. The PTY smoke's policy, in turn, still refuses to start a Chat.

## Not yet supported

Switching an existing Terminal between surfaces, Chat on mobile, image input, slash commands, and
the Claude Agent SDK provider.

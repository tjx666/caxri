---
kind: living
status: current
---

# Agent Chat

A Chat is an Agent Terminal created with the `chat` surface. It runs the user's own, unmodified
Agent CLI through the vendor's structured protocol and renders a conversation (streamed Markdown,
collapsible tool rows, approval and question cards) instead of a terminal grid. The decision and
its trade-offs are in [ADR 0012](adr/0012-agent-chat-surface.md). Chat is the primary Agent surface
and the default target for new Agent features, while the PTY surface stays supported; see
[ADR 0015](adr/0015-chat-primary-agent-surface.md).

Codex, Claude Code, and Grok Build are Chat-capable (`capabilities.chat` in the provider catalog,
`packages/protocol/src/agent/agents.ts`). Copy that names the Agent
(failure banners, "Starting ...", the composer placeholder) reads the catalog's `displayName`.
Claude Code's `displayName` is "Claude": the Chat is built on the Claude Agent SDK, whose
[branding guidelines](https://code.claude.com/docs/en/agent-sdk/overview#branding-guidelines) do not
permit an integration to call itself "Claude Code". Server messages about the user's installed
Claude Code itself (hook configuration, minimum version) still name it.

## Provider seam

`AgentChatService` owns everything provider-neutral: the Terminal row, the projection and its
revisions, patch coalescing, lifecycle delivery, and process state. Each provider is a driver in
`agentChatDrivers` (`chat-drivers.ts`) that creates one `AgentChatProviderSession` per live process
(`chat-provider.ts`). A session only translates its protocol into projection operations and
lifecycle events through the `AgentChatSessionHost` callbacks, which the service fences so a
replaced session's late reports are dropped. Shared pieces:

- `ProviderProcess` (`provider-process.ts`): the child in its own process group, stderr drained
  without being retained, and the stdin EOF, SIGTERM, SIGKILL stop escalation. It records the
  group in `agent_chat_process_groups` (group ID plus the leader's `ps` start time) until the
  group is reaped. A Server Core killed with SIGKILL cannot reap, so the next start
  (`reapStaleProviderGroups`, `provider-process-groups.ts`) reads the table and stops each group
  after checking the process table: a leader with another start time, or surviving members older
  than the recorded leader, mean the ID was reused and nothing is signaled. It logs
  `agent_chat.stale_groups_reaped`.
- `chat-items.ts`: bounded string helpers, closing dangling items, the operations for a process
  that ended, the `answered` notice, the replacement diff for a file edit, and the prompt text of a
  slash command that runs as a message.
- `JsonRpcConnection` (`json-rpc-connection.ts`): newline-delimited JSON-RPC over the child's
  stdio, shared by Codex (which omits the `jsonrpc` field) and Grok Build's ACP (which requires it).
  It bounds frame size and pending writes and ignores responses to requests it never sent.

| Provider    | Driver                             | Protocol                                                           |
| ----------- | ---------------------------------- | ------------------------------------------------------------------ |
| Codex       | `providers/codex/chat-session.ts`  | `codex app-server --listen stdio://` JSON-RPC                      |
| Claude Code | `providers/claude/chat-session.ts` | Claude Agent SDK streaming input over the user's own `claude` CLI  |
| Grok Build  | `providers/grok/chat-session.ts`   | ACP (Agent Client Protocol) v1 over `grok agent --no-leader stdio` |

Adding a provider means:

- a driver registered in `chat-drivers.ts`;
- its item mapping;
- its launch-settings translation;
- its permission mapping and opening settings in `<provider>-permissions.ts` (the level table in
  each direction, kept apart from the provider-neutral helpers in `chat-permissions.ts`), with the
  levels it offers declared in `agentChatPermissionCapabilities`;
- its catalog capability row in `packages/protocol/src/agent/agents.ts` (`chat`,
  `chatRewindFiles`), which `chat-drivers.test.ts` checks against the driver: a session has
  `restoreFiles` exactly when `chatRewindFiles` is true;
- a fake CLI fixture.

The service, reducer, and pane do not change.

## Surface and identity

- `terminal.create` takes `surface: 'chat'`; omitting it creates a PTY. The Desktop default for Agents is a Chat
  (`session.openAgentsInChat` defaults to true). The surface is stored in the
  `terminals.surface` column; only a surface switch (below) changes it. `isChatTerminal` is the one
  predicate every surface-dependent path checks.
- `session.create` takes the same optional `surface`, so a new Session can start with a Chat as its
  first Terminal. Server Core refuses a Chat for an Agent without `capabilities.chat` before writing
  anything (`canUseAgentChat`).
- Users choose the surface through one setting, `session.openAgentsInChat` (Settings, or the
  "Always Open Agents in Chat" toggle at the foot of the New Session and New Terminal menus and the
  centered Agent-choice dialog). Each menu lists every Agent once and gives a row one muted suffix:
  "Chat" when choosing it opens a Chat, "Default" for the configured default Agent, or "Chat ·
  Default" for both. Direct creation with a default Agent and `Cmd+T` follow the setting too,
  while a click on the tab strip's `+` clones the primary Agent Terminal on its own surface.
- A Chat keeps everything else a Terminal owns: its Session, Primary Agent election, naming, pane
  placement, and the `terminal` pane resource.
- The Agent Session (the Codex thread id, the Claude Code session id, or the Grok Build session id) is bound to the Terminal
  only when the first turn starts. Neither provider writes its record before that, so an earlier
  binding could never be resumed. An unbound Chat simply opens a new conversation on its next
  start. Claude Code is started with a preset `--session-id`, and Grok Build's `session/new` with a
  preset `_meta.sessionId`, so the id is known before the turn.
- PTY-only operations (raw Terminal input from other Clients, long pastes, mobile submits,
  restore) reject or skip a Chat through
  `apps/server/src/domains/pty-guard.ts` before any side effect. A phone drives a Chat through
  the `mobile.agentChat.*` methods instead; see [Mobile](#mobile).
- The Agent-facing control paths drive a Chat through `AgentChatService` instead
  (`apps/server/src/domains/agent-dispatch/chat-target.ts`). `terminal.sendInternal` (`caxri
terminal send`) delivers its text as one Chat message, queued behind a running turn; every
  message submits, so `--enter` changes nothing. An attention reply (`attentionGeneration`) is refused
  with `CONFLICT`, because a Chat answers its requests through `agentChat.respond`. Interrupt
  stops the running turn, and stop ends the provider process but keeps the Terminal and its
  conversation (`AgentChatService.stopProvider`); the next read or message starts it again.
  Dispatch `resume` and `wake` restart a stopped Chat on its bound Agent Session; see
  [Agent dispatch receipts](agent-dispatch-receipts.md#agent-chats). Dispatch `start` creates a
  PTY Terminal, except a visible delegation child, which opens as a Claude Code or Codex Chat while
  Open Agents in Chat is on; see [Agent Chat children](agent-delegation.md#agent-chat-children).
- Source Control review comments and bug reports reach a Chat as one message through
  `AgentChatService.send`, starting an idle Chat on demand. A review prompt over the long-paste
  threshold is saved with `LongPasteService.saveForChat` and referenced by path; a bug report's
  screenshot is attached as a Chat image when the provider accepts images (Claude Code, Codex),
  and its temporary file path stays in the report either way.
- Idle suspension parks a background Chat by stopping its provider and keeping its projection;
  selecting the Session resumes it. See [Agent suspension](agent-suspension.md#agent-chats).
- Batch Session compaction compacts an idle, live primary Chat through its provider protocol and
  never starts a stopped one; see [Batch Session compaction](session-compaction.md).

## Switching surface

A Chat-capable Agent Terminal reopens on the other surface from the `Terminal | Chat` toggle on the
tab rail (accessible name "Open as Terminal or Chat", shown for the active tab), its tab's context
menu and its Session row menu ("Open as Chat" / "Open as Terminal"), or
`terminal.switchAgentSurface` (`cmd+shift+j`, also in the command palette), or a phone's Session
menu (`mobile.terminal.switchSurface`; see [Mobile](#mobile)), all through
`terminal.switchSurface` (`apps/server/src/domains/terminal/surface-switch.ts`). The Terminal row,
tab, title, and Primary Agent election stay; only the process is replaced.

- The current process stops first: the PTY through the same barrier a suspension uses (cause
  `surfaceSwitched`), or the Chat provider through its orderly stop. Then `surface` flips and the
  bound Agent Session resumes there: `thread/resume` or the Claude Code transcript for a Chat,
  `codex resume <thread>` or `claude --resume <session>` for a PTY. A failed Chat resume is the
  usual visible `resume_failed`; it never starts a new conversation.
- An unbound Agent (no Agent Session yet, or a Claude Code session whose transcript was never
  written) has nothing to carry over, so the other surface starts a new conversation (outcome
  `startedNew`). A PTY restart passes `launchAgent`, because the Chat's orderly stop left the Agent
  `stopped`, which on its own restarts only a Shell.
- A running turn is never ended silently. Server Core answers `turnRunning` instead of switching;
  the Renderer asks "Stop the running turn?" and only Stop and Switch repeats the request with
  `interruptTurn`. A Chat's turn is its projection's active turn; a PTY's is the Session's
  `running` or `waiting` activity while it is the Primary Agent (a secondary PTY Agent has no
  per-Terminal turn state, so it switches like a restart).
- Each request logs `terminal.surface_switched` with a closed outcome (`switched`, `startedNew`,
  `turnRunning`, `failed`), both surfaces, the provider, and the duration.
- "Copy Resume Command" in the tab menu (Copy › Resume Command in the Session row menu) copies
  `cd <cwd> && <executable> <launch arguments> <resume tokens> <id>` (`agentResumeCommandLine`) to
  continue the bound conversation in the provider's own TUI outside Caxri. The executable and
  launch arguments come from the provider's Settings at copy time, so the YOLO switch and any
  model or permission flags carry over; the resume tokens are the provider catalog's `resumeArgs`.
  It is disabled until the Agent has a conversation. Like every Renderer copy, it writes through
  Main's `clipboard.write`, because `navigator.clipboard` rejects while the document lacks focus,
  as it can right after a native menu closes.

## Process lifecycle

Provider Hook lifecycle frames are execution metadata, not conversation content. Routine
progress, successful or cancelled hooks, and unknown system diagnostics stay out of Chat,
including plain stdout, empty JSON, and control JSON. Failed hooks show their name, exit code,
and readable failure details in an error callout. Structured control JSON stays hidden.
Explicit blocking reasons keep their full text and warning severity. Local mod command results
use a separate callout with the plugin and command name, so they cannot be confused with an
assistant reply. Tool-scoped feedback stays with the main or subagent conversation that owns the
tool use id. Raw Hook lifecycle responses carry no Agent identity and remain Session-level feedback
rather than being guessed as main Agent output. The same feedback survives Terminal-to-Chat
switching and history restoration; live SDK events and persisted records have distinct envelopes.
Local `--plugin-dir` launch arguments also carry through to the Chat SDK. Server Core sends each
callout's heading as a closed kind with the provider's own Hook, plugin, and command names
(the notice item's `heading`), and each Client words it in the reader's language with
`agentChatNoticeHeading`, so a Chinese interface reads `Hook "PreToolUse" 执行失败` while the
provider's details stay as written.

Codex Chat applies the same rule to the app-server's feedback notifications
(`apps/server/src/domains/agent-chat/feedback/codex-feedback.ts`). A `hook/completed` run that `failed` is an
error titled with its event (`Hook "PreToolUse" failed`) and its error entries; Codex reports no exit
code, so a silent Hook reads `hook exited with code N`. A `blocked` or `stopped` run is a warning
with its feedback and stop entries. A run that completed, and `hook/started`, stay out of Chat.
`warning`, `configWarning`, `guardianWarning`, and `deprecationNotice` become warnings in the running
turn, one per text and turn because Codex repeats them. `model/rerouted` names the model that
answered instead (`Model changed`), and `model/verification` shows Codex's own Trusted Access for
Cyber copy. Each shown notice logs `agent_chat.provider_notice` with closed values only. Codex keeps
none of these in `thread/read`, so they do not survive a restart or a Terminal-to-Chat switch, and a
subagent thread's feedback is not shown.

The feedback callouts follow [Paseo's notification presentation](https://github.com/getpaseo/paseo/blob/64693f21cf564389a0b74b57777267761e27f71c/packages/app/src/components/message.tsx):
severity color, an icon, and a readable body. Mod command output and blocked input use the warning
treatment; a failed Hook is an error. An error or warning body renders as Markdown with its line
breaks kept, because Hooks write for the Agent and quote commands in backticks; command output stays
verbatim so its space-aligned columns survive (`agent-chat-feedback.tsx`).

`AgentChatService` (`apps/server/src/domains/agent-chat/service.ts`) owns one provider child per
live Chat (`codex app-server --listen stdio://`, `claude` in stream-json mode, or
`grok agent --no-leader stdio`), spawned by Server Core. Its environment
(`prepareChatLaunch` in `apps/server/src/domains/agent-chat/chat-launch.ts`) is the same base
environment as other Agent launches (`agentCommandEnvironment`: the variables the user's interactive
login shell exports, overlaid by the Server's allowlisted launch context, login-shell `PATH`, and the
Agent `HOME`), so an MCP server key exported from a shell startup file reaches the provider exactly as
it would in the user's terminal; plus one of the two per-launch
additions a PTY Agent receives from `apps/server/src/domains/terminal/lifecycle-environment.ts`:

- No lifecycle-hook environment: the Chat synthesizes its own lifecycle signals, so hooks would
  double-report.
- The Agent Endpoint environment (`CAXRI_MANAGED_AGENT`, `CAXRI_AGENT_ENDPOINT_*`,
  `CAXRI_USER_DATA_DIR`, `CAXRI_CLI`, `CAXRI_CLI_PATH`), from `agentChatEndpoint`
  (`apps/server/src/domains/agent-chat/endpoint/agent-endpoint.ts`): `caxri` commands a Chat Agent runs act as
  its own managed Agent identity, with the same capabilities as a PTY Agent, so it can message peers
  and [start work in a new Session](agent-delegation.md#start-work-in-a-new-session). Without it, the
  CLI would fall back to the owner's identity, which the bundled skill forbids an Agent to borrow.

- **Lazy start.** The provider starts on the first `agentChat.read` or `agentChat.send` (the one
  eager start is `session.resume` taking a detached Chat back; see Detach). Server
  Core restart therefore never relaunches idle Chats, and boot-time Terminal restore skips them. A
  failed or detached Chat does not start on a read, and neither does a Chat whose Session is
  archived or whose Project is hidden: the admission fence refuses it, and the first read after
  the Session returns to the Workbench starts it.
- **Capacity.** A Chat that owns no process (stopped, suspended, or failed) is not counted against the
  Terminal limits, so starting its provider takes a slot: `startChat`, the one gate every read, send,
  restart, and resume passes, refuses with `CAPACITY` at 16 live Terminals in the Session or 32 overall,
  as creating a Terminal does. A read at the limit leaves the Chat stopped and shows its projection; a
  send or restart reports the error. A PTY relaunch (`TerminalManager.relaunch`) is gated the same way.
- **Observation lease.** The protocol needs the provider to report a bound Chat's models, commands, and
  live state, so a read still starts it, but a provider that a read alone started holds only a lease
  (`ChatState.readLeaseAt`), whether or not the Chat is bound yet. Any input ends the lease. Once its Session is left (or, when the Session
  was never observed being left, once the read is) for `CHAT_OBSERVATION_LEASE_MS` (2 minutes), the
  idle sweep stops the provider, with `terminal.suspended` reason `observation`, whatever the idle
  suspension setting says. Only the newest `MAX_CHAT_OBSERVATION_LEASES` (3) leases wait out that
  window; a read-started provider triggers an immediate sweep that reclaims the older ones, so browsing
  many Chats in a row holds a bounded number of providers. The usual guards still apply: the selected Session, a phone watching the
  Chat, a turn, an approval or question, a running task, and a queued message all keep it. The
  projection stays, and reopening the Chat resumes the same Agent Session. The Renderer's Chat
  snapshot cache is separate: evicting a snapshot there never closes a provider.
- **Resume.** A bound Chat resumes its thread with `thread/resume`, verifies the returned id, and
  rebuilds the projection from the returned history. `model` is omitted on resume so the thread
  keeps its own model and effort. A failed resume is a visible `resume_failed` failure, never a
  silent new thread.
- **Claude Code resume.** Claude Code does not replay a resumed conversation over the protocol, so
  the history comes from the bounded tail of its JSONL transcript, read through the same
  Server-derived path as `terminal.transcript`. Sidechain (subagent) and harness records are
  skipped, a visible user prompt opens a turn, and every resumed turn is finished. A missing
  transcript or a `--resume` that fails its handshake is `resume_failed`.
- **Answered notices across a resume.** No provider's history holds the `answered` notices Caxri
  synthesizes, so each is saved in `agent_chat_answered_notices` (Chat, turn, the item it followed,
  and the notice) when the user answers. Every history replay, including the first one after a
  Server Core restart, puts each back after the item it followed, or after its turn's first item,
  while the replay still holds that turn. A replay that rebuilt some history deletes the notices
  whose turn it no longer holds (a rewind past them); the rows also go with the Terminal.
- **Grok Build resume.** `session/load` replays the conversation as `session/update` frames before
  it answers, with `turn_completed` marking where each turn ended; the Chat folds them into one
  reset. An unknown session id fails `session/load`, which is `resume_failed`. A replayed
  `_x.ai/interject` is its own `user_message_chunk` inside the turn it joined, wrapped for the model
  with what the user typed in `content._meta.displayText`; the Chat shows that text as a steered
  message of the same turn (verified on Grok Build 1.0.62).
- **Stop.** Closing or deleting the Terminal, switching it to a PTY, or archiving or detaching the
  Session stops the child (stdin EOF, then SIGTERM and SIGKILL on its process group).
  `terminal.restart` restarts it; a fresh restart drops the thread binding first. A failed Chat
  stays failed on read; the pane's Retry restarts it, which clears the failure and resumes the
  bound thread.
- **Admission.** A teardown retires the Chat's in-memory state before it awaits the provider.
  Queued input is admitted again when it reaches the head of the Chat's send chain, after a start
  it joined, and right before a provider spawns: the state must still be current and the Terminal
  row must still exist as a Chat that is not detached and whose Session is neither archived nor in
  a hidden Project. Input that waited behind a close, archive,
  detach, restart, or surface switch therefore rejects instead of relaunching the provider, and a
  start whose Chat was torn down before it spawned is abandoned. `ChatStates`
  (`apps/server/src/domains/agent-chat/chat-states.ts`) owns the fence and the marker it reads.
- **Detach.** `session.detach` hands the Session's live Chats to another client the way it parks
  PTY Agents: the requested exit records `detached` instead of `stopped`. A detached Chat's read
  returns the projection as `stopped` without relaunching it, and input fails with `UNAVAILABLE`,
  so a pane remount, a reconnect, or a phone coming to the foreground never takes the thread back.
  `session.resume` clears the marker and relaunches the thread, as it relaunches detached PTY
  Agents, so a pane or phone that read the Chat while it was detached receives the replay as
  patches; an explicit restart (Retry, a switch to Chat) clears it too. Because the projection still reads `stopped`,
  the Desktop pane reads the Terminal record's `lastProcessState`: while it is `detached` the
  composer refuses input and a neutral row above it carries the PTY recovery bar's Detached label
  with Resume, which restarts the Chat. The phone reads the same record: it shows `Chat was handed
off on your computer`, refuses input, and offers no Resume, matching its detached PTY Terminals.
  A conversation the provider reports open in another of its own apps or windows
  (`conversation_in_use`) is a state, not a fault, too: the Desktop row takes the same neutral
  border with an info glyph and a polite `status`, says `Close it there, then retry.`, and offers
  Retry; only a real failure reads in `--danger` as an `alert`.
- **State.** `lastProcessState` and `lastAgentProcessState` follow the child: `starting`,
  `running`, `stopped` after an orderly stop, `detached` after a detach, `dead` after an
  unexpected exit, `failed` with a closed `failureReason` when it cannot start. Orderly Server
  Core shutdown stamps `interrupted` through the shared shutdown path, not completion.
- **Running count.** Live Chat children count toward `activePtyCount` and `terminal.runningCount`
  (whole app or one Session), so Server Core idle exit, `server.stop`, the window-close
  confirmation, the Quit dialog, and Session or Project deletion prompts treat them like live PTYs.
  `terminal.runningCount` reports `{ terminals, chats }` separately, and those confirmations name
  each kind with its own plural and leave out a kind with nothing running, for example
  `Close this window while 1 Terminal and 2 Chats are running?` or
  `Delete 'X' and terminate 1 running Chat?`.
  Choosing Terminate and Close stops the Chat
  provider process with the PTYs and records it `stopped`; the Chat service keeps running, so the
  next read on the same Server Core starts it again.

## Launch settings

The launch settings configured for the TUI are translated, not appended
(`apps/server/src/domains/agent-chat/launch-settings.ts`). Codex:

| TUI argument                                 | Chat equivalent                                          |
| -------------------------------------------- | -------------------------------------------------------- |
| `--dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`, `sandbox: danger-full-access`   |
| (absent)                                     | `approvalPolicy: on-request`, `sandbox: workspace-write` |
| `--model`, `--sandbox`, `--ask-for-approval` | The thread field of the same meaning                     |
| `--config`, `--profile`                      | Kept as root options before `app-server`                 |
| Anything else (`--search`, UI flags)         | Dropped: it has no meaning outside the TUI               |

Claude Code:

| TUI argument                                              | Chat equivalent                              |
| --------------------------------------------------------- | -------------------------------------------- |
| `--dangerously-skip-permissions`                          | `permissionMode: bypassPermissions`          |
| (absent)                                                  | `permissionMode: default` (manual approvals) |
| `--permission-mode`, `--model`, `--add-dir`, `--settings` | The SDK option of the same meaning           |
| `--allowedTools`, `--disallowedTools` (either spelling)   | `allowedTools`, `disallowedTools`            |
| Anything else (UI flags)                                  | Dropped: it has no meaning outside the TUI   |

Grok Build (root options go before `agent`, agent options after it):

| TUI argument                                    | Chat equivalent                                       |
| ----------------------------------------------- | ----------------------------------------------------- |
| `--yolo`, `--always-approve`                    | `agent --always-approve`                              |
| (absent)                                        | Manual approvals through `session/request_permission` |
| `--model`/`-m`, `--reasoning-effort`/`--effort` | `agent --model`, `agent --reasoning-effort`           |
| `--sandbox`, `--permission-mode`                | Kept as root options before `agent`                   |
| Anything else (UI flags)                        | Dropped: it has no meaning outside the TUI            |

`--no-leader` is always passed: otherwise a configured `[cli] use_leader` turns `agent stdio` into a
bridge to a shared leader process that Caxri cannot own.

A Chat's own permission level, once chosen, replaces the approval and sandbox parts of these
settings; see [Permission level and plan mode](#permission-level-and-plan-mode).

The Claude Code Chat uses the `claude_code` system prompt and tool presets and loads the user's,
Project's, and local settings, so it behaves like the TUI in the same folder.

## Claude Code mapping

The SDK speaks Claude Code's stream-json control protocol; Caxri passes the resolved executable as
`pathToClaudeCodeExecutable` and spawns it through `spawnClaudeCodeProcess`, so the SDK's bundled
binary is never used and `ProviderProcess` owns the child. ADR 0012 deferred a dedicated Chat worker process
until the SDK arrived; because the SDK only frames stdio for that separate `claude` child, it runs
inside Server Core without one. `providers/claude/items.ts` holds the pure message mapping,
`claude-history.ts` rebuilds a resumed Chat from the transcript, and `providers/claude/requests.ts` holds
pending permission prompts and questions until the user answers:

- Claude Code has no turn ids. A turn is named by the uuid of the user message that started it and
  ends with the `result` message once `queued_turn_count` is zero. Caxri also sets
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, and `session_state_changed` bounds turns
  authoritatively: Claude Code starts turns on its own (for example once a background task
  finishes), which open under a synthetic `auto:` id, so the queue waits for them, the composer
  offers Stop, and a surface switch asks before ending that work. Output that arrives with no turn
  open also opens one. A steered message is sent with `priority: 'next'`. The prompt is recorded
  locally because Claude Code does not echo it.
- Text and thinking stream from `stream_event` deltas and are finalized by the complete
  `assistant` frame under the same id (model message id plus the block's per-kind ordinal).
- `Bash` is a command row that keeps the tool's `description`. Its result settles the exit code
  (Claude Code reports a failure as an error result starting `Exit code N`, so a success is 0) and a
  duration Caxri measures from the `tool_use` to its result, because Claude Code reports none. A
  command started with `run_in_background`, or moved there by the user or a timeout
  (`backgroundTaskId`, `backgroundedByUser` in the structured result), is marked `background` and
  carries neither, since it finishes after the hand-off. Settling lives in `providers/claude/tool-results.ts`.
- `Edit`/`MultiEdit`/`Write`/`NotebookEdit` is a file change whose diff is
  replaced by Claude Code's `structuredPatch` when the result arrives, `TodoWrite` the plan, and
  every other tool a generic tool row. Subagent frames (`parent_tool_use_id`, with
  `forwardSubagentText`) go to the subagent's own task projection, never the parent timeline; see
  [Background work](#background-work).
- Usage is the latest model request's input plus cache plus output tokens; the context window
  comes from the result's per-model usage. See [Context usage and cache](#context-usage-and-cache)
  for the breakdown, compaction window, and cache lifetime.
- A replayed turn's duration comes from the transcript's `turn_duration` record when present. Claude
  Code writes that record only in its interactive CLI, never for an SDK-driven Chat, so otherwise
  `history/claude-turn-clock.ts` sums the span from the turn's prompt to its last main-thread
  record. An `enqueue` queue operation or a background task notification opens a new span, so the
  idle wait before a wake-up does not count.

## Grok Build mapping

`providers/grok/chat-session.ts` speaks ACP and `providers/grok/items.ts` holds the pure mapping:

- A turn is one `session/prompt`, named by the `promptId` Caxri sends in its `_meta`; the prompt's
  result carries the stop reason (`end_turn`, `cancelled`, `max_tokens`, `refusal`) and the
  conversation's token count. Grok Build does not echo the prompt, so it is recorded locally. A
  steered message goes to the running turn through `_x.ai/interject`; Caxri never sends a second
  `session/prompt` mid-turn, since Server Core's follow-up queue owns queueing.
- `agent_message_chunk` and `agent_thought_chunk` stream text and reasoning. `tool_call` and
  `tool_call_update` are merged per call id, the update's present fields replacing earlier ones: an
  `execute` call is a command row, a call carrying `diff` content a file change, and anything else
  a generic tool row. `plan` replaces the plan.
- The model and its context window come from the `session/new` or `session/load` result; slash
  commands from `initialize`'s `_meta.availableCommands` and `available_commands_update`, run as
  prompt text. Interrupt sends `session/cancel` and waits for the prompt to return `cancelled`.

## Projection and streaming

Server Core keeps a bounded, in-memory projection per Chat (`AgentChatSnapshot` in
`packages/protocol/src/agent/agent-chat-contract.ts`): items, turns, the active turn, pending
requests, the plan, model, and token usage. It is never persisted or logged; the provider's own
record is the source of truth.

- `agentChat.read` returns the snapshot. Updates arrive as the transient `agentChat.patch` event,
  which never enters the durable journal. Deltas are coalesced into one patch per 16 ms window.
- Providers deliver text in uneven bursts, so Clients pace a streaming reply onto the screen
  instead of drawing each patch as it lands (`agent-chat-stream-pacing.ts` in
  `packages/protocol/src/agent/streaming/`, adapted from LobeHub's `useSmoothStreamContent`). Each animation
  frame reveals a share of the hidden text proportional to the backlog, so a burst eases in over
  roughly 180 ms while a steady stream stays a few characters behind. Text already present when a
  reply mounts shows at once, a rewrite that does not extend the shown text shows whole, and the
  full text shows the moment the reply stops streaming (completed, failed, or interrupted). Desktop
  paces every frame; the phone redraws at most every 32 ms because each redraw re-parses the reply.
- Each run of characters the pacer adds fades in over 500 ms on both Clients, so the reply's tail
  reads as a soft gradient (`agent-chat-revealed-runs.ts` beside the pacer tracks the runs). Text a
  reply mounted with shows at once, and reduced motion skips the fade. Desktop renders each run as a
  CSS-animated span. The phone's Markdown renderer mints new keys on every parse, so Mobile keeps the
  runs and their arrival times outside the rendered tree, by the order of text nodes, and draws each
  run in a nested `Text` whose color alpha follows its age. It keeps at most 24 fading runs per text
  node instead of Desktop's 90 and stops fading a reply past 2,000 characters, where splitting the
  tail on every re-parse would start to drop frames.
- Every patch carries `baseRevision` and `revision`. Server Core and every Client apply operations
  with the same reducer (`packages/protocol/src/agent/agent-chat-reducer.ts`); a Client whose
  revision does not match re-reads. Server Core flushes queued operations before each read so a
  snapshot never contains an operation a later patch would repeat. A restart or close drops the projection
  but never reuses a revision: the replacement starts one past the last revision, so a Client
  holding the old snapshot sees a gap and re-reads instead of discarding new patches.
- Bounds: 1,000 items, 64 KiB per message, 16 KiB of command output (the tail is kept), 64 KiB per
  diff, 1 MiB of diffs per file-change item, and a 4 MiB aggregate text budget. The budget also holds
  while a reply streams. Older items leave the projection first and `truncated` is set. A diff cut
  by either diff bound carries its own `truncated` flag, so the pane marks where it stops.
- Items that leave the projection are not lost. Server Core moves them, with their turns, into a
  per-Chat history archive (`apps/server/src/domains/agent-chat/history/archive.ts`, bounded
  at 20,000 items and 32 MiB of text). `agentChat.readHistory` pages back through it, at most 200
  items or 2 MiB per page, by the id of the oldest item a Client holds. Past the archive, a Claude
  Code Chat reads the rest from its transcript (up to 128 MiB, parsed once and cached for a minute
  while the reader pages back); other providers already replay their whole history into the
  archive on resume, so their history ends there. A resumed history is applied in one batch, so a
  Client receives only the items the projection keeps, never the evicted ones. A subagent task
  keeps the same kind of archive per task projection (bounded at 5,000 items and 8 MiB of text),
  and `agentChat.readHistory` with a `taskId` pages it for the task's tab; a task rebuilt from the
  provider's record replays every item, so its projection keeps the newest 500 and archives the
  rest. The snapshot's
  `historyId` changes on every replaced history (a resume, a rewind, a reset), so a page read for
  an earlier history is discarded rather than stitched onto the new one.
- Once a Desktop pane has scrolled back, it keeps the items the projection evicts so no gap opens
  between the pages read and the live view. That copy is bounded at 5,000 items
  (`apps/desktop/src/renderer/src/features/agent-chat/transcript/agent-chat-history.ts`): past it the oldest
  kept items are dropped, never while a page is on its way, and the next scroll-back reads them again.
- A Client that receives a patch while its own read is still in flight holds the patch (up to 200)
  and replays it once the read lands, instead of dropping it and re-reading again.
- The stdio connection frames Codex output by bytes, rejects an oversized frame before parsing
  it, and stops a provider whose stdin backlog passes 8 MiB rather than buffering without bound.
- Items a turn left open (an interrupted command, a cut-off message) are closed as `interrupted`
  when the turn ends or the process exits.
- An item's optional `createdAt` is when it began. Server Core stamps an item on its first live
  upsert (`stampNewItems` in `apps/server/src/domains/agent-chat/chat-projection.ts`) and the
  reducer keeps it across later upserts that omit it. A history replay is not stamped with the read
  time: Claude Code history takes each message's transcript record time. Codex dates a resumed user
  message by its turn's `startedAt` (Unix seconds), then dates the other items from
  `thread/items/list`'s `startedAtMs`, newest first and bounded. Grok Build stamps every replayed
  frame with its original `_meta.agentTimestampMs`, and an item takes the time of the frame that
  created it. An item with no recorded time stays undated, so it shows no time rather than a wrong
  one.

## Background work

Subagents, Claude Code workflows, and background shells are tasks: the snapshot's `tasks` lists
each one (kind, title, status, agent type, model, usage, the timeline item that started it, and
whether it can be stopped),
and each task has its own projection (`AgentChatTaskSnapshot`) with its own revisions, patched by the
transient `agentChat.taskPatch` event exactly like the parent projection. A task projection holds a
subagent's conversation (500 items, 512 KiB of text) or a shell's output tail, so a chatty subagent
evicts only its own history. Server Core keeps at most 50 tasks per Chat (ended ones drop first) and
20 task projections in memory (ended ones are evicted first and rebuilt on the next read).

- `agentChat.readTask` returns the live projection, or rebuilds one from the provider's record for a
  task this process never saw (a resumed Chat, an evicted projection); `taskId` may also be the id of
  the timeline row that started the task, so a subagent row stays openable after a restart.
  `agentChat.stopTask` stops one task without ending the turn. A provider exit marks every running
  task stopped. A Codex subagent stopped this way never reports back to its parent (multi-agent v2
  treats an interrupted child turn as non-final), so a main Agent waiting on it would wait out the
  whole `wait_agent` timeout. When the main turn is in a running `wait`, Server Core therefore steers
  a note into it saying the user stopped that subagent (`steerNotice`, a `turn/steer` whose
  `clientUserMessageId` starts `notice:`); the steer ends the wait, and the timeline shows the note
  as a `Caxri told the Agent` notice rather than a user message. It never starts a turn: an idle or
  not-waiting Chat gets no note. `agent_chat.task_stop_noticed` records the closed outcome.
- **Claude Code.** A subagent's task id is its `Agent`/`Task` tool use id. Metadata comes from the
  tool call and the `task_started`, `task_progress`, `task_notification`, `task_updated`, and
  `background_tasks_changed` system messages. A background shell uses Claude's `task_id` and links
  its Bash row, or the `Monitor` row whose command it watches (titled by the Monitor description, the
  command kept for its tab); its output tail comes from polling the SDK's `getTaskOutput` about once a second.
  `perTaskStopAffordance` keeps background subagents alive across an interrupt; a background shell
  outlives an interrupt either way, with no task event (verified with Claude Code 2.1.296). `stopTask`
  maps to the SDK's `stop_task`. History is rebuilt from
  `<session>/subagents/agent-<id>.meta.json` (matched by `toolUseId`) and its `.jsonl`. A workflow
  (the `Workflow` tool's `local_workflow` task, which runs in the background) is listed as a
  stoppable background `agent` task keyed by its tool use id and titled by its script's
  `workflow_name`, or `Workflow` without one; the agents inside it are not listed. Its frames follow
  the SDK's types and have not yet been captured from a real CLI.
- **Codex.** A subagent is a child thread; its task id is the child thread id and its row is the
  `collabAgentToolCall` (or `subAgentActivity`) item. App-server sends no `thread/started` for a
  spawned child, so notifications from an unknown thread are held briefly (8 threads, 500 each) until
  a spawn item names it. Codex's `wait` and `closeAgent` items name their receivers only by thread id,
  so the Server writes the subagents' Background work titles (a spawn's first prompt line, a v2 path
  name) as their summary, rebuilt from the spawn items on resume: a row reads `Waited for Review the
diff`, and a work summary whose waits name one subagent reads `waited for Review the diff`, as the
  Codex TUI's `Waiting for <agent>` does. Stopping interrupts the child's turn; history comes from
  `thread/read`. A
  `commandExecution` with a `processId` still running when its turn ends becomes a shell task;
  Caxri initializes with `experimentalApi: true` so `thread/backgroundTerminals/terminate` can stop
  it. Codex stops streaming a command after 10,000 deltas, which sets `isOutputCapped`. A resumed
  thread lists each command its history still shows running in a finished turn as a stopped shell
  task ("Ended: Caxri restarted and can no longer track it"), since the app-server that ran it is
  gone; one `thread/backgroundTerminals/list` still reports is taken back running and stoppable.
  That list is read at start, after each turn, and when a running shell's tab opens, one read at a
  time: a request made during a read gets one more read after it, shared with every other request
  made meanwhile, so a turn end never settles for an answer from before Codex reaped a terminal. A
  terminal that completed while a read was in flight is not taken back running from that answer.
- **Grok Build.** No tasks are projected yet: its background task updates are ignored, `stopTask`
  answers `CONFLICT`, and `readTaskHistory` knows no task.
- **Pane.** A subagent or background row opens its task in a Workbench tab
  (`caxri-agent-task://<terminalId>/<taskId>`, `packages/protocol/src/domain/agent-task-tab.ts`) in a
  split beside the Chat, reusing that side pane for later tasks. The split keeps the Chat readable
  instead of halving the host: the Chat grows to at most 800px, the side pane takes the rest but no
  less than 360px, and a host too narrow for a 420px Chat plus that minimum opens the tab as an
  ordinary tab. While such a pane sits right of its own Chat, the Secondary Sidebar yields its width;
  `Cmd+]` reveals it for that Session and Root, and it returns when the side pane closes
  (`features/agent-chat/tasks/beside-chat-layout.ts`). Turn reviews, the side chat, and the Context
  breakdown share this side pane. A subagent tab is a read-only
  timeline with its title, type, model, status, and Stop; a shell tab shows the command and its
  live output, titled by the command without Codex's login-shell wrapper. Running tasks also appear
  in the composer strip's collapsible Background work section, headed `Background work N` and, folded, by the latest
  task to start (`agentChatBackgroundWorkFoldedTask`), where each opens or stops on its own, and an `Ended N` row at
  the foot of the list expands the ended ones; a single running task with no failure is the section's
  only row, without a header (`agentChatBackgroundWorkSoleTask`). The section is live status, not a log: it leaves once the
  last task ends and its failures were dismissed, since the Agent reports the result in the conversation
  (`agentChatTaskStrip` in `packages/protocol/src/agent/agent-chat-tasks.ts`, whose `agentChatTaskStripView` the
  phone shows; see [Mobile](#mobile)). A finished task stays reachable from its
  timeline row.

### Subagent rows in the sidebar

A Chat's subagents also show as indented child rows under their Session in the primary sidebar, so
a running subagent is visible without opening the Chat. The sidebar never reads a Chat (an
`agentChat.read` would start an idle provider), so Server Core persists a minimal summary per
subagent in `agent_chat_subagents` (task id, title, agent type, closed status, start and end
times; no transcript content). `ChatProjection` reports a changed task list through
`onTasksChanged`; `ChatSubagentSummaries` upserts the summaries, keeps the first-seen start time,
keeps at most 50 per Chat (running rows are evicted last), and publishes a `records` state change.
`createLiveTerminalRecord` projects the rows onto `TerminalRecord.subagents` for Chat Terminals
only; the PTY surface and Grok never get them.

- Stale-running rule: tasks are in memory only, so a Server Core start marks every persisted
  `running` row `stopped` (`agent_chat.subagents_reconciled`, closed reason `serverStart`, with a
  terminal count and no titles). A resumed Chat that reports the task again rewrites the row.
- The Renderer shows running subagents first, then the rest by recency, newest 3 by default with a
  `Show N more` row right after them. Expanding opens the rest below that row, which then reads
  `Show fewer`, so the list folds again from the same place. A decorative vertical guide under the
  Session's Agent icon ties the rows to it. The setting `primarySidebar.showSubagents` (default on)
  hides them.
- A Codex subagent first seen through a multi-agent v2 `subAgentActivity` item is titled with the
  last segment of its `agentPath` (`/root/planner/reviewer` reads `reviewer`).
- Clicking a row selects its Session first, then opens the subagent's task tab.

## Follow-up queue

A message sent while a turn runs waits in Server Core's queue by default and goes out once the Chat
is idle, in order; a message also waits behind earlier queued ones. One dispatch joins the run of
messages at the head of the queue into a single message (texts separated by a blank line, every
image attached) and starts one turn for all of them, as far as one message may carry (text length,
image count, combined image size); a queued slash command ends the run and takes a turn of its own. `agentChat.send` with `delivery: 'steer'` instead adds it to the running turn (Codex
`turn/steer`, Claude Code `priority: 'next'`, Grok Build `_x.ai/interject`). A slash command issued during a turn is queued.
User messages record how they arrived (`delivery: 'queued' | 'steered'`). The mark lives in the
provider's own record, so a resume after a restart still shows it: Codex keeps it as the
`clientUserMessageId` prefix (`queued:<uuid>`) its user message echoes as `clientId`; Claude Code
records a steered message as a `queued_command` attachment, and a queued one carries a version-8
uuid whose third group is `8c01`. Grok Build replays an interjection with `_meta.displayText`, which marks it steered, and
echoes the `promptId` it was sent with as `prompt_id` on the replayed `turn_completed`; a queued
prompt's id carries the same uuid marker as Claude Code's (`queued-prompt-uuid.ts`), so a resume
shows both marks. Grok Build does not echo the `interjectionId`, which is not needed.

- The snapshot's `queue` lists each entry's text, image count, and command; image data stays on
  Server Core. At most 20 entries and 256 KiB of text.
- `agentChat.interrupt` pauses a non-empty queue (`queuePaused`, with `queuePauseReason: 'stopped'`) so stopping a turn never fires the
  next message by surprise; `agentChat.resumeQueue` continues it. A joined send that fails pauses the queue with
  `queuePauseReason: 'sendFailed'` (or `'deliveryUnknown'` when delivery could not be confirmed), so
  the composer names the failure and offers Retry instead of reading like a user Stop. `agentChat.removeQueued` drops an
  entry and `agentChat.sendQueuedNow` sends one ahead of the rest (steering a running turn; a
  command cannot steer). `agentChat.takeQueued` backs Edit on every Client: it removes an entry
  and returns its full text (a command as `/name arguments`) in one step, so an entry the queue
  sends meanwhile fails with `CONFLICT` instead of being both sent and back in the composer. An
  entry carrying images stays queued and fails with `VALIDATION`, since images never return to a
  composer. The Desktop queue card edits such an entry in place instead:
  `agentChat.editQueued` replaces the text of a queued message and keeps its images (and any
  path-reference prefix the card leaves alone), and the row shows "N images attached"; an empty
  text without images, or a command, fails with `VALIDATION`. The returned text goes ahead of any draft
  (`agentChatDraftWithReturnedMessage`). Removing an entry keeps it in a bounded Server stash
  (10 entries) with the entry that followed it, so the Undo toast's `agentChat.restoreQueued`
  puts it back at its original position (at the end when that successor already left), and
  fails with `CONFLICT` once the stash no longer holds it. A failed dispatch puts every joined entry back in order and pauses
  the queue.
- A Codex `turn/start` or `turn/steer` that times out may still have started the turn, so Codex
  Chat checks before failing: the user message's `clientId` echo, or `thread/turns/list` over the
  newest turns. A recorded message counts as delivered. One it cannot confirm fails as delivery
  unknown: the entry stays in the paused queue (Send now and Remove still work), and the timeline
  gets an `error` notice telling the user to check the conversation before sending it again, so
  nothing is sent twice automatically.
- The queue survives a restart of the Chat and goes out once the new process is ready; it is never
  persisted across Server Core restarts.
- In the composer, Enter steers during a turn and Cmd+Enter queues, for every provider: most of
  the time a message typed mid-turn is meant for the work in progress, and Claude Code and the Codex
  CLI also fold it in by default once the current tool call returns. A message that only makes sense
  after the turn takes Cmd+Enter. While a Codex main Agent waits on its subagents, the steer also
  ends multi-agent v2's `wait_agent` early (the older v1 `wait` reads it once the wait returns). The
  send button reads `Steer message` while a turn runs and turns into an accent `Queue message` while
  Cmd or Ctrl is held; its tooltip lists `Steer` Enter, `Queue` ⌘Enter, and `Stop turn` Esc. With
  no turn running but the Chat busy (compacting, or draining the queue) Enter queues. A slash
  command issued during a turn still queues. Queued entries form one list
  above the composer, each with Steer or Send now, Edit (back into the composer), and Delete; a
  paused queue says so in the list header with Resume. Enter (or Cmd+Enter) in an empty composer
  sends the head of the queue now, as its Steer or Send now would, and the placeholder says so while
  one waits; a slash command at the head during a turn still waits. A phone steers and queues the
  same way; see [Mobile](#mobile).
- Compaction (Codex `contextCompaction`, Claude Code `status: 'compacting'`) sets the snapshot's
  `operation` to `compacting` and raises `compactionStarted`; input sent meanwhile is queued. The
  `/compact` user bubble is hidden because the compaction notice already represents it.

## Edit from here

Hovering a user message that started a turn shows "Edit from here" beside Copy; right-clicking any
user message opens a native menu with the same actions (Copy Message, preceded by Copy and followed
by Add to Message when text is selected, then Edit from Here, Fork from Here, and Restore Code to Here), each disabled with the hover row's
reason when it cannot run and left out when the message does not offer it
(`agent-chat-user-message-menu.ts`). It puts the
message's text into the composer (any draft is set aside) and opens the edit bar above the input:
how many turns sending replaces, an "Also revert file changes" checkbox, and Cancel (Escape), which
brings the set-aside draft back (Cancel's tooltip names Escape only while Escape cancels; during a
running turn Escape stops the turn). A turn review comment added to the Chat during the edit lands in
the edited message and is also recorded on the edit (`appendedDraft` in `agent-chat-edit.ts`):
Cancel, or editing another message instead, puts it back after the set-aside draft rather than
dropping it with the edited text, while a sent edit already carries it and brings back only the
set-aside draft. The edited message keeps a quiet `--muted` outline, leaving the accent to the edit
bar. Sending calls
`agentChat.rewind`, which rewinds the provider's own record to just before the message and sends
the draft in its place as one request; a later resume shows the same shorter conversation. As with
a message, the composer does not wait for the answer: once any confirmation below is accepted, the
edit bar closes and the set-aside draft comes back while Send says it is sending, and a refused
rewind reports why and reopens the edit with the sent text and images. The edit
survives switching tabs and restarting Caxri, like a draft: the edit (message id, the revert choice,
and the set-aside draft) is mirrored to device-local `localStorage` (`caxri.agent-chat.edits`,
bounded to the 50 newest edits), so a restart never brings back the earlier message's text as an
ordinary draft with the held-back draft lost.

- Only a settled Chat rewinds: while a turn runs, the action and Send are disabled and say to stop
  the turn. A steered message did not start its turn, so it offers no edit, and a message with
  images cannot be edited, as with a queued message. Server Core checks the same rule
  (`agentChatRewindTarget` in `packages/protocol/src/agent/agent-chat-rewind.ts`) and answers
  `CONFLICT` when the Chat changed under the request.
- Reverting files can discard the user's own later edits to those files, so it asks first in a
  native dialog (`agentChat.confirmRevertFiles`); Cancel sends nothing and keeps the draft.
  Replacing more than one turn without reverting files asks in the in-app confirmation instead
  (`Replace N later turns?`, confirmed with Replace Turns), pointing at Fork from Here as the way to
  keep them (`agent-chat-rewind-copy.ts`); an edit of the message's own single turn sends without
  asking, since the edit bar already names it.
- Each provider rewinds with its native mechanism; Caxri takes no snapshots of its own.
  `capabilities.chatRewindFiles` says whether files can be reverted, and when they cannot, the
  checkbox stays disabled with the reason on hover.
- "Restore code to here" sits beside "Edit from here" for a provider that reverts files: it calls
  `agentChat.restoreFiles`, which puts back the files changed from that message onward and keeps
  the conversation, as Claude Code's `/rewind` "Restore code" does. It asks first in the same
  native dialog, follows the same running-turn and turn-start rules (a message with images can
  restore code, since nothing returns to the composer), logs `agent_chat.files_restored`, and
  confirms with a success toast (`Restored the code changed in N turns`), since the transcript
  itself does not change.
  Before either revert asks, the Client calls the read-only `agentChat.previewRestoreFiles`, and
  the dialog lists the files to revert with `+N -M` per file and the totals. Claude Code answers
  from `rewindFiles(uuid, { dryRun: true })`, which reports only file names and totals, so Server
  Core takes each file's counts from the edits the Chat recorded in the turns being reverted (a
  file changed some other way lists without counts). The native dialog shows the first eight files
  and "...and N more". A provider with no preview (Grok Build exposes none) shows no list; a
  failed or slow (10 s) dry run shows "Couldn't preview changes" and the dialog stays usable.
  Claude Code uses `rewindFiles` alone, without a restart; Grok Build uses
  `_x.ai/rewind/execute { mode: 'files_only' }`. Codex offers no file restore, so the action is
  absent there.

| Provider    | Conversation                                                                            | Files                                                                      |
| ----------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Codex       | `thread/revert { beforeTurnId }`, then a resume reads the remaining turns               | Not supported: `thread/revert` leaves files alone                          |
| Claude Code | Restart with `resumeSessionAt` (`--resume-session-at`) at the record before the message | `rewindFiles(messageUuid)` after a dry run, with `enableFileCheckpointing` |
| Grok Build  | `_x.ai/rewind/execute { mode: 'conversation_only' }`                                    | The same call with `mode: 'all'`                                           |

Claude Code's transcript is append-only: a conversation resumed at an earlier record continues from
there and leaves the old continuation in the file. History replay (`claude-history.ts`) follows the
active branch from the newest record and drops a sibling branch only where the active branch
continues with a new user prompt, because parallel tool calls branch the file too. Editing the
first message has no earlier record to resume at, so the Chat starts a new Claude Code session.

The rewind point is stored in `terminals.chat_resume_record_id` and cleared when the first new turn
starts (or the Agent Session is replaced), because until a turn writes past it, any start would
otherwise resume at the newest record and bring the rewound turns back. This matters when the
edited message failed to send or Server Core restarted in between.
File checkpoints are taken only from prompts sent with checkpointing on, so a Chat started before
it was enabled, or a message older than the transcript tail Caxri reads, refuses to revert files
with the reason. Grok Build names a prompt by its index in the whole session, which the Chat may
not hold in full, so Caxri counts back from the newest of `_x.ai/rewind/points` and checks that the
point's preview matches the message before rewinding. An `_x.ai/interject` adds no point of its
own (verified on Grok Build 1.0.62: one interjection and two prompts list two points), so a steered
message does not shift the count. Mobile does not offer the action.

## Fork from here

Beside "Edit from here", a message that started a turn offers "Fork from here". It copies the
conversation up to just before that message into a new Agent Session through the provider's own
fork, opens it as a Chat in a new Session of the same Project and cwd, puts the message's text in
the new composer, and selects that Session, then a success toast names where the conversation went
(`Forked into a new Session: <title>`). The source Chat is not touched, and nothing is merged
back. `agentChat.fork` creates the Session without selecting it; the Renderer writes the composer
draft first and then selects it, so the new composer mounts with the text.

- The availability rule is the edit's (`agentChatRewindTarget`): a running turn disables the
  action, and a steered message offers none. A message with images forks too; only its text
  returns to the composer.
- Forking the first message of a conversation the Chat holds in full asks no provider and opens an
  empty Chat: Codex writes no rollout until a thread's first turn, so an empty fork could not be
  resumed.
- The new Session's Chat Terminal is bound to the forked Agent Session before it starts, so its
  start is an ordinary resume. File checkpoints stay with the source: an edit in the fork can
  revert only files its own turns changed.
- The new Chat keeps the source Chat's stored permission level and plan mode, so a fork of a Chat
  narrowed to Ask for approval or Read only, or running in plan mode, never starts broader. A source that stored
  no choice leaves the fork on the Project default, like any new Chat.
- A fork whose new Session cannot be created after the provider already forked leaves that record
  in the provider's store with no Session to open it; Caxri does not delete it, and logs the failure
  as `orphaned`. A Codex fork whose `thread/unsubscribe` fails still opens, and the failure is
  logged with its reason.

### Fork Session

The Session row menu (sidebar and Activity queue) offers "Fork Session", which copies the Primary
Agent's whole Chat conversation, through its latest turn, into a new Session the same way; the new
composer starts empty. It is `agentChat.fork` without an `itemId`. The entry is disabled with the
reason when the Session has no Agent, its Agent runs in a PTY Terminal (open it as Chat first), or
it has no conversation yet. Server Core refuses a running turn or compaction, and a Chat without a
turn, with `CONFLICT`. A Codex fork omits `beforeTurnId`, a Claude fork omits `upToMessageId`, and
a Grok Build fork omits `targetPromptIndex`, which copies the whole session (verified on Grok Build
1.0.62).

The same menu groups the Session's own actions, Fork, its Agent, where to open it, a Copy submenu
(Conversation ID, Transcript Path, Resume Command), and Archive with Delete at the end, the order
Codex's sidebar menu uses.

| Provider    | Fork                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Codex       | `thread/fork { beforeTurnId }` (experimental), then `thread/unsubscribe`, since the new Chat resumes it elsewhere   |
| Claude Code | The Agent SDK's `forkSession({ upToMessageId })` at the record a rewind would resume at, over the Chat's own folder |
| Grok Build  | `_x.ai/session/fork { targetPromptIndex }`, the index a rewind takes; the new Chat opens it with `session/load`     |

The Agent SDK resolves Claude's settings folder from Server Core's environment, once per process,
while each Chat runs Claude Code with its own environment, so `forkClaudeSession` hands
`forkSession` a session store over that Chat's `CLAUDE_CONFIG_DIR` transcripts. Like the SDK's own
loader, the store skips a transcript line that is not valid JSON (a truncated trailing line, a
corrupt record) and counts it for `agent_chat.forked`. The SDK needs the whole session, so a
transcript above 256 MiB is refused with `CAPACITY` before it is read. Mobile does not offer the
action.

## Approvals and questions

Claude Code asks through the SDK's `canUseTool` callback, keyed by the tool use id. `Bash` is a
`command` request, file tools a `fileChange` request linked to their item, `AskUserQuestion` a
`question` (answers are returned keyed by question text), and any other tool the generic `tool`
request (`Allow WebFetch?` with its URL or arguments). "Accept for this Chat" is offered only when
Claude Code suggests a session rule and applies those suggestions; decline denies the tool and
marks its row declined. The transcript records a decline only as the error result `The user
declined this action.`, so a replayed history (`claude-history.ts`) reads that exact result as
declined too, and the row looks the same after Server Core restarts.

Grok Build asks through `session/request_permission`, keyed by the tool call id; its permission
options (`allow_once`, `allow_always`, `reject_once`, `reject_always`) set the offered decisions,
and Skip or a decision with no matching option answers `cancelled`. Grok Build reports a rejected
call as `failed`, live and in its `session/load` replay (one merged `tool_call` frame per call, no
later `tool_call_update`), with the text ``User rejected the execution
for tool `<tool>` `` (verified on 1.0.50), so `providers/grok/items.ts` reads that text as declined and the row
looks the same after Server Core restarts; any other failure stays failed. Caxri turns on
`_x.ai/ask_user_question` (`_meta.askUserQuestion`) when it opens the session, and each question
request becomes a `question` keyed by its `toolCallId`. Grok Build's questions carry no id or
header, so question ids are positional (`q0`, `q1`, ...) and the answer goes back keyed by question
text: one string, or a list for a `multiSelect` question. Skip answers `{"outcome":"cancelled"}`,
which Grok Build reads as "the user declined to answer" and continues the turn. On
`session/cancel` Grok Build stops the turn without withdrawing a pending question and ignores a
later answer, so Caxri answers it `cancelled` and clears the card when the turn ends.

Codex server requests become pending `requests` keyed by the approval callback id when present,
else the item id. Codex re-sends pending requests with fresh transport ids after a resume, and
several callbacks can share one item, so the transport id is never the key.

- `agentChat.respond` answers one request; a request that is no longer pending fails with
  `CONFLICT`. Approvals take a decision (`accept`, `acceptForSession`, `decline`, `cancel`);
  questions take answers per question id. Skip answers a question with no answers, which Codex
  reads as "no answer"; any other decision for a question is rejected.
- Approval cards show what is being approved: the command and its working directory (relative to the
  Project, hidden at its root), the network host for a network approval, the diff of every file a
  file-change approval would touch (read from the file-change item the request gates), and Codex's
  stated reason. Only the decisions Codex lists in
  `availableDecisions` are offered, with one addition: a list with `cancel` also offers `decline`
  (Deny). Codex's default command approval lists `accept` and `cancel` only, yet its app-server
  takes `decline` for any command approval and continues the turn without running the command, as
  its own TUI's "No, continue without running it" does. `cancel` itself is never a card button;
  stopping the turn is the Stop button's job. Controls stay disabled while an answer is in flight.
- A Codex command approval that lists `acceptWithExecpolicyAmendment` (with a usable
  `execpolicy_amendment`, falling back to `proposedExecpolicyAmendment`) also offers
  `acceptAlways`, shown as `Always Allow <prefix>` (`alwaysAllowPrefix` on the request, display
  only; the tooltip carries the whole prefix). Unlike "Always Allow in This Chat", Codex writes
  the rule to `<CODEX_HOME>/rules/default.rules`, so it applies to every Codex Chat. The Client
  sends only `acceptAlways`; `CodexRequestBroker` keeps Codex's amendment and answers
  `{ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment } } }`, and rejects the
  decision with `VALIDATION` when none was proposed. Network approvals do not offer it (their rule
  would be a host rule, `applyNetworkPolicyAmendment`, which Caxri ignores). On Mobile the button
  gets its own row. There is no Caxri UI to list or revoke the rules; edit `default.rules`.
- A question form with several questions shows one tab per question. Its primary button reads Next
  while a later question is neither answered nor opened yet, and moves to it; once every question
  has been answered or seen it reads Submit (`questionFormPrimaryAction` in
  `agent-chat-question-flow.ts`).
- A `multiSelect` question (Claude Code's and Grok Build's `multiSelect: true`) lists its options
  as checkboxes: a click or a digit key ticks one, Enter moves on, and the answer carries every
  ticked option plus any typed one. Claude Code receives them joined with `,`, Grok Build as a
  list. Codex questions have no multi-select form.
- The Workbench's waiting popup asks for a Chat the user is not looking at. `agentChat.pendingRequests`
  lists every Chat whose provider is still running and that holds a request, with the user's latest
  message as context; it reads only Server Core's in-memory projections, so it never starts or
  resumes a provider. The Renderer re-reads it when an `agentChat.patch` replaces a Chat's
  `requests` or resets it, and after a reconnect. Chats whose pane is on screen in this window are
  left out, since their own card already asks. The popup sits top-center below the title bar
  (`min(640px, 92vw)`), shows the oldest waiting request with the Chat's provider, Session,
  Project, and an Open Session button, counts the rest ("N more pending"), and folds into an
  "N pending" status-bar item that unfolds it on click and unfolds on its own when a new request
  arrives. A click on a question's option only
  selects it, so the user confirms with Submit; the popup never takes focus by itself (`Focus Waiting
Request`, `agentChat.focusWaitingRequest`, bound to Cmd+Alt+W, unfolds it and moves focus to the
  question's selected option or the approval's first button; Tab then reaches the other controls,
  since options are one roving tab stop, as in the docked card), and its keys (digits, Enter, Escape
  to fold) work only while focus is inside it. Answering from inside keeps focus on the next card, and
  answering the last one returns focus to where the command took it from.
  The approval keys are registry commands, `agentChat.allowRequest` (Cmd+Enter) and
  `agentChat.denyRequest` (Cmd+Backspace), available only while some approval can take them
  (`agentChatApprovalKeyOwner`): inside a pane with its own approval, that card while the composer
  holds no draft; anywhere else, the popup's approval, and only from a focus target that does nothing
  with the key (the document body or a static element). A text field, contenteditable, Terminal,
  editor, button, link, or row keeps the chord, so a Session row's Cmd+Backspace still archives. An
  unavailable command lets the key through untouched. Key repeats are ignored and the popup's 450ms
  arm delay also covers the keys, so a held or doubled press cannot answer the next card.
  A PTY Terminal Agent waiting on the user gets a read-only entry too (`kind: 'terminal'` in the same
  `agentChat.pendingRequests` list, `entries` beside the Chats' `kind: 'chat'`): Server Core lists each
  non-archived Session whose lifecycle state is `waiting` and whose running Primary Agent Terminal is a PTY, from stored
  rows only, so the read still wakes no provider. The card shows the provider, Session, Project, and "Waiting for your
  response in Terminal" with Open Session, which selects the Session and its Terminal; there is no form and nothing is
  written to the PTY, since the prompt is a TUI screen the hooks cannot describe. It queues and counts as one request
  with the Chats, and a Terminal pane on screen in this window removes it. The Renderer re-reads the list when the set
  of Sessions marked `waiting` changes, so the entry also leaves when the Agent resumes.
  A file-change approval shows no diff there and points to the Session instead. The design
  follows LobeHub's `GlobalApprovalNotification`; Caxri Bot window does not show it.
- An answered question leaves an `answered` notice in the timeline, so the transcript records what
  the user chose after the card disappears.
- Requests Caxri cannot render are answered immediately (MCP elicitation is declined, anything
  else gets a JSON-RPC error) so the turn never blocks on a request no one can see.
- Each pending request raises Attention through a synthesized `attentionRequested` signal and
  clears it with `attentionResolved`, so Activity and the Primary Sidebar behave as for a PTY.
  Selecting a Session normally acknowledges its unread Attention at once, but not while its primary
  Chat holds a request and that Chat's pane is not on screen in this window (a Chat on a background
  tab): the Sidebar row and Session tab keep the Attention glyph until the user shows the pane or the
  request is answered or withdrawn, then it is acknowledged like any other (`session-attention.ts`).

## Pane

- The transcript and the composer share one centered column. Pending approvals, questions, the
  plan, and the failure banner sit in a dock above the composer, outside the scroller, so reading
  history never hides them. The plan stays one collapsed row (the current step and `done/total`)
  until the user expands it, so a long plan never pushes the transcript out of view. The timeline follows new output until the user scrolls up; Jump to
  latest returns to the end. While it shows, the transcript ends above it, so the button never
  covers the last line of text.
- The composer keeps an unsent draft per Chat across tab and Session switches and across a full
  restart, clears only the text that was actually sent, and treats Escape as Stop while a turn
  runs. The draft text is device-local Renderer state in `localStorage` (bounded to the 50 most
  recently edited Chats), never sent to Server Core. Attached images survive a restart too, in
  device-local IndexedDB instead, because a few encoded images would exhaust the `localStorage`
  quota (`agent-chat-attachment-persistence.ts`): at most 128 MB of encoded images across all
  Chats, dropping the Chats whose images changed least recently first, deleted once the message
  that carried them is accepted or the Chat is gone, and silently skipped when unreadable. ArrowUp on an empty composer opens a list of the prompts this Chat sent, as LobeHub's chat input does: newest at the bottom nearest the input, a prompt sent again listed once at its newest place, at most 50 rows, and the highlighted prompt previewed in the input's placeholder. ArrowUp walks older without wrapping, ArrowDown past the newest closes the list, Enter or Tab (or a click) fills the input without sending, and Escape or any typed key closes it. The list is read from the user messages in the Chat's projection when it opens, so it needs no storage of its own and reaches only as far back as the projection keeps (see `truncated`). ArrowUp is left alone while the input holds text, an image is attached, a message is being edited, or another composer menu is open. A filled prompt is an ordinary draft and persists like one. Ctrl+S stashes the draft (text, caret, attachments, and Goal mode) and empties the input, as Claude Code's prompt stash does, so a quick question can go first; the placeholder says a stash is waiting, Ctrl+S in an empty input restores it, and it also returns by itself after the next send unless the user has started typing again, and both restores say so in the composer notice. A whitespace-only input counts as empty for a restore. Ctrl+S with a draft while a stash waits swaps the two (the draft becomes the stash and the stashed draft comes back, caret and attachments included) and the composer notice says so, so neither is lost and the key never dead-ends. While an earlier message is being edited Ctrl+S is refused with the notice "Finish or cancel the edit first". The stash lives in memory per Chat until Caxri quits, and the stashed notice says so. Ctrl+C with nothing selected empties the input and its attachments, as Claude Code's prompt does (over a selection it stays Copy); the text leaves as an ordinary edit, so Cmd+Z brings it back, while the attachments stay removed as they do when their placeholder is deleted by hand. A pasted `http(s)` URL renders in the input the way the sent message renders it: the same linkify rule finds it, it takes the accent color behind its site icon, and a pull request link's glyph and text take its state from the same cached reference preview. Its action row shows how much of the
  context window is used, as a filling ring and a percentage with the token counts and what fills
  the window in its popover (opened by a click, or by Enter or Space on the focused ring, never by hover). Below 85% the
  pie is a neutral glyph with no number; from 85%, where compacting is suggested, it turns `--warning` and shows the percentage, and the model and effort picker (see "Model and effort" below). Activating a Chat's tab puts the cursor in the composer, as activating
  a Terminal tab focuses its grid, under the same rules: not behind a modal, not out of another
  text field, and not when arrow-key tab navigation activated it, which keeps focus on the tab.
  A single status row at the top of the composer card says whether the Chat is starting or working (while a turn works
  on an active goal, the goal row says it instead; see [Goals](#goals)), with the plan and
  background work as collapsible sections above it (`agentChatPlanSection`, `agentChatBackgroundWork`); a working turn shows one verb chosen per turn from its id, its elapsed time, and on the right what the turn
  has spent so far, as LobeHub's composer tray does: steps, tokens (the Usage page's `total`), and
  the cost estimated from the bundled price list (a bare figure, its currency in the tooltip), each behind an icon with a pointer tooltip. A figure still at zero
  is hidden, a single step too, and a strip narrower than 360px keeps only tokens. The elapsed time, these figures, and
  the context ring's percentage roll their changed digits to each new value (`AnimatedNumber`, see `DESIGN.md`
  "Motion"). Only a change after 1.5s of stillness rolls, so the ticking seconds and tokens climbing while a reply streams jump while minutes, steps, and cost roll; the live time keeps `0s` on a whole minute so its seconds never fade out for one tick. Server Core sums each Claude
  response once by message id (subagent responses included) and each Codex request from
  `thread/tokenUsage/updated` (a subagent's own thread included, deduplicated per thread and counted toward the turn active when it arrives, so a late report never lands on the next turn) into the snapshot's `turnUsage`; Grok Build reports usage only when a turn ends, so its strip shows none. The row holds no key hints: Send's tooltip
  lists Enter (queue), ⌘Enter (steer), and Esc (stop turn), and holding Cmd or Ctrl turns Send into Steer. After a turn that was stopped or failed, an empty composer's Send turns into
  Continue (a small play glyph on the same neutral circle as Send, as in the Codex app): a click sends `Continue` in the interface language as an
  ordinary message, the one the user would otherwise type (`isAgentChatTurnResumable`). The Codex app starts an
  empty turn instead, which not every provider supports. Enter in the empty input stays inert, so a stray press never
  sends; typing, an attachment, a queued message, Goal mode, or "Edit from here" brings Send back. The plan
  and background work are collapsible sections in the strip above the row, each folded or unfolded per Chat for the
  window's lifetime (`agentChatStripFolds`). A failure from the latest turn stays in the Background work section until
  the user dismisses it with the section's X (`agentChatSeenTaskFailures`, per window), and only failures that ended
  during the latest turn count, so reopening a Chat never resurfaces old ones. Only the activity summary and the strip's
  `N running · M failed` counts are polite live regions, so the ticking time is never announced.
  Send's tooltip reads `Send` (or `Queue` during a turn) with an Enter keycap; Cmd+Enter's Steer
  keeps its own text.
- Work renders as one-line rows (`Ran git status`, `Read <file>`, `Edited <file> +2 more`),
  each with the tool kind's glyph from the provider tool table shared with mobile
  (`packages/protocol/src/agent/agent-tool-presentation.ts`). Codex's login-shell wrapper
  (`/bin/zsh -lc "..."`) is unwrapped so a row shows the script that ran. A tool no table maps is
  titled by a readable input field (`SendMessage to researcher: Check the tests`), or `key: value`
  of its first scalar field, never its raw JSON input; the item's `input` keeps that JSON preview
  for the expanded row (`agentChatToolCallArguments`), and an approval card always shows the JSON
  arguments, since that is what the user decides on. MCP calls keep JSON arguments in `summary` for
  tracker detection. Desktop titles an MCP row by its tool alone and shows the server's icon: the
  first time a tool call names a server, Server Core asks the provider for that server's MCP
  `initialize` identity (`readMcpServer`: Codex `mcpServerStatus/list`, Claude Code
  `mcpServerStatus()`), keeps its title, `serverInfo.icons`, and website or endpoint origins in the
  snapshot's `mcpServers`, and retries a server that was still connecting after a minute, at most
  three times. Main fetches a remote icon through `links.favicon`, falling back to the sites'
  `/favicon.ico`. `mcpServers` keeps the newest 20 servers, and inline `data:` icons share 64 KiB across them (a server
  whose icon no longer fits keeps its HTTPS icons and site origins); an HTTPS icon URL over 2048 characters is dropped. The phone receives `mcpServers` without inline icons (name, title, site origins, and HTTPS icon URLs of at most 512 characters) and loads those icons directly, drawing the connector glyph while one loads or when none does; a row whose server has an icon titles itself by the tool alone, as Desktop's does, and otherwise keeps the server name in the label. A command the Agent
  described (Claude Code's `Bash` description) is titled by that description, and its command line
  moves into the expanded view. A row shows its duration once it reaches a second, a non-zero `Exit N`, and a
  `Background` tag for a hand-off; the expanded view ends with its exit code. Codex reports no
  description or background state for a command, so its rows show the command line. Consecutive work collapses
  into one summary row. While work is active, that row shows the newest running action and target
  ("Reading app.ts", "Running git status --short"); after all work settles it switches to the aggregate.
  Once some work has settled, a newly running action takes over the row only after it has run for 1s
  (`agentChatWorkSummaryItems`), so a burst of brief calls keeps counting up instead of flashing each one.
  A kind that joins the summary after it appeared (`, waited for Agent`) fades in; a count changing inside a phrase,
  and the phrases already there when a Chat opens, stay still (`agentChatWorkSummaryPhrases`).
  Once a turn ends its work and commentary fold behind `Worked for X`
  (`Stopped after X`, `Failed after X`), keeping the prompt, the final reply, and notices other than
  a transient retry in view. A message steered into the running turn starts a new segment there:
  each segment folds its own work behind a row timed from its first item to the next segment's, and
  keeps its own last reply in view, so every steered message stays above the answer it got. Only the
  closing segment's row carries the turn's outcome; a stopped turn whose closing segment folded nothing still gets that row before its reply. A retry reads as a `--warning` row whose icon and words name the cause
  from a closed set (`retry.cause`: a lost connection shows Wi-Fi off, then rate limit, overload,
  server error, other) with the attempt against the provider's limit (`Connection lost, retrying
(2/10)`), and the provider's detail muted beneath. Claude Code's `api_retry` gives the cause through
  `error_status` (null for no response) and `error`; Codex gives it through `codexErrorInfo`, its
  `Reconnecting... N/M` message gives the attempt, and `additionalDetails` the detail. Once the same turn makes progress (a later reply, thought, or tool
  item from either provider), the shared reducer marks the notice `retry.resolved` and the row settles
  into a muted check reading `Recovered after 2 retries` with the stale detail dropped; a newer retry
  replaces the notice and turns it amber again. Retry rows are plain text, not a live `status`, because
  the timeline remounts history. A running turn stays expanded, and running work sweeps a highlight across its verb instead of
  swapping its glyph for a spinner; a row seen running animates its tool's glyph until it settles
  (`agentChat.animatedToolIcons`), and the composer status line's indicator follows
  `agentChat.workingIndicator` (Buddy acting out the turn's current tool from the snapshot's
  `activity.work`, or the spinner). A thought shows the latest bold title Codex opens a reasoning
  summary part with (`Thinking Planning the fix`). Back-to-back reasoning items merge into one thought
  row whose expanded view lists every summary in order, its bold titles in the row's muted color. Expanded command and tool output is
  painted in the language inferred from what produced it: the extension of a file a `cat`/`sed`/
  `head` printed or a Read tool returned (with Claude Code's line-number gutter removed), `diff` for
  `git diff`/`git show`, or JSON; anything else stays plain text. Timeline folding lives in
  `apps/desktop/src/renderer/src/features/agent-chat/transcript/agent-chat-timeline.ts`, which takes the
  fold range from `foldAgentChatTurn` in `packages/protocol/src/agent/agent-chat-turn-fold.ts`,
  shared with the phone; the work row and
  summary wording, turn labels, and output-language inference every client shares live in
  `packages/protocol/src/agent/agent-chat-work.ts` and `agent-chat-work-output.ts`. Every surface
  hides a sub-second duration through `formatNoticeableDuration`.
- Replies render Markdown through the shared `@caxri/markdown` block tree
  ([`components/markdown/`](../apps/desktop/src/renderer/src/components/markdown/markdown-blocks.tsx)):
  leveled headings, nested and task lists, quotes with a hover Copy quote (the quote's text without
  its `>` markers, `blocksPlainText`), tables with Copy table (Markdown plus HTML), and fenced code
  with a header (language, word-wrap toggle, Copy code) painted by Monaco's colorizer once the
  fence closes. A closed `bash`, `sh`, `shell`, `shellscript`, or `zsh` fence also offers Run in
  Terminal (`run-command/agent-chat-run-command.ts`): it opens a shell Terminal in the Chat's
  Session, started in the Agent's working folder (`agentCwd` when Claude Code entered a worktree),
  and types the block at the shell's first prompt, released by shell integration's `OSC 133;A` or,
  for a shell without integration, after five seconds (`terminal-prompt-input.ts`). The first Run
  splits a pane below the Chat; later Runs add tabs to that pane while it stays open. `console`
  and `fish` fences stay copy-only, since one mixes prompts with output and the other is not the
  user's shell syntax. Under a finished reply, Copy message and the time the reply began mount only
  while the pointer is over the reply or focus is inside it, the latest reply included
  (`agent-chat-reply-frame.tsx`); the row keeps its height, so revealing it never shifts the
  transcript. Option+ArrowUp and Option+ArrowDown step focus between replies and user messages,
  which reveals each one's row. Right-clicking a reply opens a native menu with Copy Message; with
  text selected inside it, Copy comes first and Add to Message follows, which quotes the selection
  into the composer as the selection toolbar's quote does.
- The speed and cost are recorded on the turn once, when it ends
  ([`turn-metrics.ts`](../apps/server/src/domains/usage/turn-metrics.ts)): output
  tokens and generation time come from the transcript throughput read (the responses that completed
  inside the turn's window), and the cost is the turn's `turnUsage` captured at its end. A turn
  replayed from provider history, or one too short to rate, shows only what it has. The same
  record also freezes the turn's steps and total tokens (`requests`, `totalTokens`), so the turn's
  `Worked for` fold row ends with the turn's figures after it finishes, interrupted or failed ones
  included, and after a restart; the row that closes a steered turn carries them once. They show
  while the pointer or focus is on the row, in the composer strip's order: the subagents the turn
  started (a `Bot` glyph and the count; one opens its tab, several open a menu), steps, tokens,
  cost, and the output rate last (zero figures and an unpriced cost left out). The rate's glyph is
  the service tier most of the turn's responses ran on (the record's `speed`: `Rabbit` fast, `Gauge`
  standard or unrecorded, `Turtle` flex), not a threshold on the number.
- Message times follow the Codex app. A centered day break (`Today 17:59`, `Yesterday 09:12`,
  `Oct 3 17:59`) heads the first user message of each day. Under a user message, a hover row shows
  its time and Copy message, mounted only while the pointer or focus is on the message; the row keeps
  its height, so revealing it never shifts the transcript. A link preview card in a user message
  opens above the link, so it never covers that row.
  Every time carries a tooltip with the full date. Formatting and day grouping live in
  `apps/desktop/src/renderer/src/features/agent-chat/transcript/agent-chat-time.ts`.
- A subagent's task tab pages its own history the same way (history head, auto-load near the top,
  position held, Retry on failure) and shows the "earlier messages are not shown" note only when
  the provider's record was cut off, never at the real start.
- Scrolling back reads the whole conversation, not only the projection. Near the top, the pane
  loads the previous page (`agentChat.readHistory`) 1,600 px before the reader reaches it and keeps
  the entry at the top of the view where it was, so the page appears above without moving the
  text. While a page loads the top says `Loading earlier messages…`, a failed read offers Retry,
  and when Chat cannot show the rest (a provider without a readable record, or history past the
  archive and transcript bounds) it says so and offers Open as Terminal. History read back is
  rendered apart from the live projection, in chunks split at turn starts chosen by item id
  (`agent-chat-settled-chunks.ts`), so a streamed patch skips it and a new page renders only its
  own chunks; each entry uses `content-visibility: auto`, so offscreen entries cost no layout or
  paint. Items the live projection evicts while the reader is scrolled back are kept below the
  pages read, so nothing goes missing between them. Earlier messages are read-only: they offer
  no Edit, Fork, or Restore, because those act on the projection.
- From the second user message, a message rail sits at the pane's left edge: one tick per user
  message, the one being read longer and brighter. The rail stays hidden until the pointer reaches
  that left gutter or keyboard focus enters it, so it never competes with the reply being read
  (`rail/hooks/use-is-agent-chat-rail-gutter-hovered.ts`). Hovering a tick, or focusing it from the
  keyboard, opens one fixed-size preview card beside it: the message's first line (or first
  sentence) as the title, up to three lines of what follows, and a corner badge naming the kind of
  message (sent by you, steered, a delegated task, or images only). The title and body never repeat
  each other: a first line too long for any title is shown whole in the body under a caption
  (`Message 3 of 12 · 17:59`), and a message with nothing after its title fills the body with that
  caption instead of blank lines. While earlier history is unloaded the rail only knows the loaded
  messages, so the caption names the send time (or the position among the loaded messages) rather
  than a total. A message with no content yet
  shows a skeleton of the same size; content already in the timeline never waits behind it. An open
  card moves to the next tick at once, and only the current tick's content is ever rendered, so a
  sweep never flashes a passed message (`rail/agent-chat-rail-preview.ts`). Clicking a tick stops
  following new output and jumps there. The rail is a single tab stop: ArrowUp,
  ArrowDown, Home, and End move among its ticks and Enter jumps. Ticks shrink together, down to a
  6px target each, rather than scroll when a long conversation would overflow the view; past 120 messages each tick stands for an even
  stretch of the conversation, so ticks stay apart
  (`apps/desktop/src/renderer/src/features/agent-chat/rail/agent-chat-rail-marks.ts`).
- Cmd+F in a Chat opens a find bar at the conversation's top right, clear of the message rail and
  Jump to latest. It takes its own strip above the conversation rather than floating over it, so it
  never covers the text it searches, and its buttons' tooltips name Enter, Shift+Enter, and Escape. It reuses the Terminal's `terminal.find` command: a Chat registers itself as its
  Terminal's search handler, so the same key reaches it in a pane or Caxri Bot window. Every
  occurrence of the query in the rendered conversation is painted through the CSS Custom Highlight
  API (`::highlight(agent-chat-find)` and `agent-chat-find-active` in `styles.css`), leaving the
  Markdown DOM untouched; matching ignores case, treats the query as plain text, and never spans
  two blocks. The bar counts `i/N`; Enter and Shift+Enter step with wraparound and scroll the
  current match to a third of the view, which stops following new output. A new query starts at
  the first match on screen rather than the top of the conversation. Matches are recomputed as a
  reply streams without moving the view: each recompute walks the whole conversation, so the first
  DOM change after a quiet spell repaints at once and a streaming reply repaints at most every
  250 ms plus once after its last change (`createAgentChatFindRepaintScheduler` in
  `agent-chat-find.ts`); typing and stepping repaint immediately. The count and stepping cover every match, but
  only the matches within a quarter of the view's height of it (plus the current one) are registered with the
  highlight API, as static ranges, and a scroll moves that window: painting a highlight costs time on every
  frame a streaming reply paints, and registering about 10k of them in a long Chat dropped streaming from about
  50 fps to 12 fps (`agentChatFindVisibleWindow` in `agent-chat-find.ts`). A finished turn folded behind
  `Worked for` opens when one of its messages mentions a query of three or more characters, since
  folded content is not in the DOM, and folds back when a refined query stops matching. Escape closes the
  bar, clears the highlights, leaves opened turns open, and returns focus to the composer. Times in
  a message's hover row are not searched, since they are invisible until hovered. Find does not read tool output
  inside a collapsed work row, earlier messages not yet loaded by scrolling back, or regular expressions.
  Logic lives in `agent-chat-find.ts` and `use-agent-chat-find.ts`.
- A web link in a reply or pasted into a user message shows the site's favicon and opens a hover
  card naming the host with an Open action. For HTTPS links, the card previews the page's share
  image, title, and description. Main reads them through the `links.preview` desktop method
  (`apps/desktop/src/main/link-previews.ts`): public hosts only (a loopback, private, or
  link-local URL, or a redirect to one or to plain HTTP, is never requested and keeps the globe and
  a card without a preview), the HTML head only, at most 256 KiB, a 5 s timeout,
  Open Graph then Twitter Card then `<title>` fallbacks, HTTPS images only, and a per-app-lifetime
  cache of 256 URLs that evicts the oldest inserted entry (a repeat hover does not refresh it; an
  outright network failure is not cached). A page that declares nothing keeps the card's link summary.
- A settled reply's `#123` or uppercase Linear identifier (`ENG-123`) renders as that web link when
  the conversation already holds exactly one matching GitHub pull request or issue, or Linear issue:
  a link in a user message or reply, or one a command or tool call filed
  (`apps/desktop/src/renderer/src/features/agent-chat/references/`). A number two repositories
  share stays text, as do mentions in inline code, inside a link's own text, and in a reply still
  streaming. User messages keep such mentions as text.
- While a reply streams, `createStreamingMarkdownRepair` (`packages/markdown/src/streaming-repair.ts`)
  completes the last block's unfinished emphasis, inline code, and links so raw syntax never
  flashes. It keeps one reply's scan state: a delta that extends the previous text scans only its
  last two lines, because complete lines' fence state and span counts are already tallied, so a
  long list no longer costs a rescan of the whole list per delta. `createStreamingMarkdownParser`
  (`packages/markdown/src/streaming-parser.ts`) parses the reply incrementally: a top-level construct
  whose first line and the line after it are complete and unchanged closes every construct before
  it (the second line because a delimiter row decides whether a line opens a table), so a delta re-parses
  only the source from the last such line on, and every settled block keeps its object identity. The
  memoized block renderer then skips settled blocks on a reference check and compares only the tail
  by value. An open list, the usual shape of a long reply, re-parses only from its latest item whose
  marker line is complete and splices the earlier item objects back in, because a new item closes
  the ones before it. A link reference definition, as markdown-it resolves it, is document-global
  and turns reuse off for that reply. On a 13 KB mixed reply streamed in 503 deltas this cut the
  characters handed to markdown-it from 251x the reply length to 7x (parse time about 140 ms to
  10 ms for the whole stream), and on a 20 KB reply that is one 200-item list from 378x to 6.5x.
- A file path the Agent cites in inline code or a link (a `path:line` code span, or a link whose destination is a relative path with an optional `#L` anchor)
  opens in the editor through the same resolver and Project candidate picker as a Terminal file
  link.
- Inline code that names a skill the [Agent Commands & Skills](agent-actions.md) discovery found for
  this Terminal (`commit`, `$commit`, or `/commit`) keeps its code chip and gains the `$skill` chip's
  icon. Hovering or focusing it opens a card with the skill's description and its `agentActions.read`
  instructions, read only while the card is open. Discovery shares the composer menu's
  `agentActions.list` query, which answers only for a running Agent; a list read earlier stays
  cached after the Agent stops, so an idle Chat keeps its marks. Commands are not marked.
- A file change collapses to `N files changed` with its `+A -D` line totals. Expanded, and in a
  file-change approval card, it lists one block per file: the Git status letter (`A`, `D`, `M`) in
  the file's `--git-*` color, the Project-relative path, the file's line counts, and a disclosed
  diff with old and new line numbers. Added and removed lines use the `--diff-stat-*` colors every
  `+N -M` count uses, and a tall diff scrolls inside its own box. Codex sends an added or deleted
  file's whole content rather than a patch, so those read as all-added or all-removed lines. A
  diff Server Core cut ends with `Diff truncated`, and its counts cover only what is shown. File
  blocks start expanded when the change touches at most three files in the timeline, or one file in
  an approval card, so a wide change does not push the decision buttons away. A path opens the file
  in the Editor when it exists at that point: an applied change keeps added files, a pending or
  declined one keeps deleted files.
  Parsing and counting live in `packages/protocol/src/agent/agent-chat-diff.ts`, shared with mobile.
- A finished turn ends with what it left behind, between its final reply and Copy (or alone when
  the turn stopped before replying), so the result survives the `Worked for X` fold. The files its
  completed changes touched merge into one card: `Edited <file>`, `Created <file>`, or
  `Edited 3 files` over the turn's `+A -D`, then Undo and a labeled Review. The counts with their
  chevron are the card's single expand toggle: hovering or focusing them swaps them for `View
changes` (or `Hide changes`) and previews every diff, and a click discloses them in place; a file
  row discloses its own diff. A file the turn created and deleted again is left out. Undo restores
  the turn's files all or nothing: each file is read and its reverse planned first, and if any no
  longer holds what the turn left (edited since, missing, recreated, or a diff Server Core
  truncated) nothing is written and a toast names the file; for a file changed since, it also
  suggests undoing the later turn first or Restore Code to Here. A complete Undo confirms with a
  success toast (`Undid the changes to N files`) and the card reads `Undone` with a Redo beside it
  for as long as this window still holds what the Undo replaced, so taking it back does not depend
  on catching the toast.
  Created files go to the Trash behind its usual confirmation; edits and deletions are reversed
  through `files.write`/`files.create`, so Session path authorization applies and a file outside
  the Project cannot be undone. Pull requests and issues the turn created or edited follow as
  cards opening the page, each with a trailing external arrow: a completed `gh pr|issue create|edit` whose output printed the URL, a
  `gh api` POST to `repos/o/r/pulls|issues` or PATCH to `repos/o/r/pulls|issues/N` (how an Agent
  rewrites a PR body from a file), or a GitHub or Linear MCP create/update/save call. An issue's card also
  starts that issue in a new Session ([Hand off with /new-session](agent-delegation.md#hand-off-with-new-session)).
  Collection lives in
  `packages/protocol/src/agent/agent-chat-turn-artifacts.ts` and its `trackers/` subdirectory, Undo in the
  Desktop `agent-chat-undo.ts`. The phone shows the same cards without Undo and Review; see
  [Mobile](#mobile).
- Review on that card opens the turn as one diff in a `Turn changes` tab beside the Chat, in the
  side pane task tabs use (`caxri-agent-turn-review://<terminal>/<turn>`). It lists the same files
  the card does, each with its Git status letter, Project-relative path, `+A -D`, and every edit
  the turn made to it in order; the projection is read from the shared `agentChat.read` cache, so
  nothing new crosses IPC. Hovering a line of code shows `+`, which opens a comment on it;
  Shift-clicking `+` on another line of the same hunk extends the range; a line in another hunk
  starts the range over there, since the hunks' line numbers need not be contiguous. Cmd+Enter or Add to message
  appends the comment to the Chat's message as a new paragraph without sending it, in the same
  form a Git diff review sends a Terminal Agent (`formatReviewComment` in
  `packages/protocol/src/domain/git-review-contract.ts`): `@path#Lx-Ly (Agent turn diff, <side>
side)`, the selected diff lines with their signs in a `diff` fence, then the comment. A range of
  removed lines alone cites the old file's line numbers; any other range cites the new file's. A
  file the turn edited more than once cites `Agent turn diff, edit <n> of <m>`, because each edit
  numbers its lines against the file as that edit found it.
  Escape cancels. Added comments stay under their lines for as long as the tab is open and are not
  stored anywhere else; the composer holds the text. When the Chat's composer is on screen the
  comment lands in it at once (`appendToAgentChatDraft` in `agent-chat-drafts.ts`), otherwise in
  the draft it opens with. The review covers finished turns, where the card appears, and only the
  changes the provider reported; it takes no Git snapshot. Logic lives in
  `agent-chat-turn-review.ts`.

## Mobile

- The dashboard projects `surface` on the primary Terminal. A phone shows a Chat in its own Chat
  tab instead of the Conversation and Terminal tabs, so it never attaches to a PTY that does not
  exist.
- A control device reopens the Session's primary Agent on the other surface from the Session
  detail menu ("Open as Chat" / "Open as Terminal") through `mobile.terminal.switchSurface`, which
  checks the device's Project grant and then calls Desktop's `terminal.switchSurface`. A running
  turn comes back as `turnRunning`, and the phone asks with Desktop's "Stop the running turn?"
  in a confirmation sheet before retrying with `interruptTurn`. On success the phone re-reads the Session and opens the
  Chat tab or the Terminal tab that now shows the Agent.
- A sealed gateway frame carries 64 KiB, while a Chat projection may hold megabytes.
  `mobile.agentChat.read` therefore returns a window of the newest items within 48 KiB and sets
  `truncated` for the rest. Each item is shortened deterministically by
  `packages/protocol/src/mobile/mobile-agent-chat-contract.ts`: messages, reasoning, and output keep
  their tail behind a `…` marker, so streamed `appendText` deltas still continue the phone's copy;
  diffs keep their head under one budget per file change.
- Earlier messages. Scrolling to the top of the phone's Chat, or tapping `Load earlier messages`,
  reads the page before the oldest item the phone holds (`beforeItemId`) through
  `mobile.agentChat.readHistory`, a read every role may call. The Server first pages the projection
  items older than the phone's window (a cursor inside the projection after its first item), then
  forwards to `agentChat.readHistory` (archive, then the provider's record). Either page is cut by
  `windowAgentChatHistoryPageForMobile`: each item clipped like the window's, the newest that fit
  48 KiB kept with their turns, and `hasMore` set when it dropped any, so the oldest item kept is the
  next cursor and nothing is skipped. The phone holds the pages in memory with the history model
  Desktop uses (`packages/protocol/src/agent/agent-chat-history.ts`): an item a later window evicts
  stays once reading started (`retainEvictedAgentChatItems`), a page for a replaced `historyId` is
  dropped and a new `historyId` starts over, and an item both a page and the window hold shows once.
  Turn folds and artifacts build over the merged list
  (`apps/mobile/src/features/agent-chat/agent-chat-older-history.ts`), and the read cache still
  saves only the window. `Earlier messages are available on your computer.` appears only once
  nothing more loads and the history is still cut (the archive or transcript ends). A thumbnail of
  a message outside the projection falls back to its original from the provider's record, since
  Core keeps no thumbnail lookup for archived items.
- The `{kind:'agentChat',terminalId}` subscription forwards each `agentChat.patch` after the
  subscribe ACK, shortened the same way. A patch that still does not fit one frame becomes a
  content-free `agentChat.changed`, and the phone re-reads. The phone folds patches with the
  shared `applyAgentChatPatch`, holds those that arrive during a read, and re-reads on any break in
  the revision chain.
- The phone renders the timeline with the shared presentation rules in `packages/protocol`, so
  its words match Desktop's: `splitAgentChatWork` keeps running work out of summaries as live
  rows (the present-tense verb and subject under a 2.2 s highlight sweep, the glyph kept, no
  spinner), `summarizeAgentChatWork` names a settled group, `agentChatWorkDuration` drops a
  duration under a second, and `agentChatReasoningTitle` titles a thought. Failed, declined, and
  interrupted steps each keep their own glyph (`agentChatItemStatusLabel`). A command's detail
  shows its description as the title, the command highlighted as shell, its output highlighted by
  `agentChatOutputLanguage` (with Claude Code's line-number gutter dropped from a read), a non-zero
  `Exit code N`, and the background note; a file change shows each file's line counts with zero
  halves hidden (`visibleDiffStatParts`) and its diff (`agentChatDiffLines`). A paired device is
  never told a Project's root, so the Server names changed files the way Desktop does before they
  leave it: the read and every subscription patch pass the Session's root
  (`mobile.session.projectRootInternal`) to the mobile projection, which makes paths inside the
  Project relative and leaves a path outside it absolute (`projectDisplayPath`). A finished turn ends under its final reply with its artifacts
  (`collectAgentChatTurnArtifacts`): the edited-files card, which expands to every file's diff but
  offers no Undo or Review, since the phone neither writes the files back nor opens a side tab, and
  a card per pull request, issue, or acceptance report that opens the page in the phone's
  [in-app browser](mobile/design.md#in-app-browser). When the
  window cut older items (`truncated`), the oldest turn in it may be missing its start; it still
  shows the artifacts of what remains, as Desktop does, so its cards never pop in mid-list once a
  fuller window or an older page arrives. The phone folds a finished turn as Desktop does
  (`foldAgentChatTurn`): its work and commentary sit behind a `Worked for X`, `Failed after X`, or
  `Stopped after X` row (`agentChatTurnLabel`) that a tap expands, and a turn with nothing to fold
  keeps the row, without a chevron, before its reply. A steered turn folds per segment there too. The Chat view holds the expanded fold keys (the turn id, suffixed by the segment index after the first),
  not the rows, so FlashList recycling never moves one turn's state onto another. The window keeps `plan`, so the phone docks a
  one-row plan card above its composer (Desktop shows the same plan as its composer strip's
  collapsible Plan section instead) (`agentChatDockedPlan`: the latest plan
  stays until the next turn starts, its step spinning only during a turn), and the line above the composer reads `agentChatActivity`:
  the turn's verb, the elapsed time after a second, `Compacting context…`, or what the turn waits
  on. The elapsed time compares the computer's `startedAt` with the phone's clock. Code lives in
  `apps/mobile/src/features/agent-chat/agent-chat-timeline.ts` and its renderers; the generic row,
  group, sheet, and list primitives stay in `features/conversation`, shared with a terminal
  Agent's Conversation.
- The phone's Chat list pins a sent message the way Desktop does (`agentChatTurnSpacerHeight`):
  the shared list takes an `isTurnStart` marker (user messages and messages still on their way)
  and keeps a spacer after the rows, sized from FlashList's measured layout
  (`conversationTurnSpacerHeight` in `features/conversation/conversation-scroll.ts`), so at the
  end the latest turn rests 16 points below the top and its reply fills in below it. The spacer's
  height is a Reanimated shared value in the list footer, so resizing it neither re-renders the list
  nor changes the measurement it came from. A streamed patch rebuilds the timeline, but
  `stabilizeAgentChatEntries` hands back the previous object for every unchanged row and the row
  components are memoized, so only the rows a patch touched redraw while the reader scrolls.
- The composer shows the model and effort the next turn uses, with the same names as the Desktop
  model menu (`agentChatModelLabel` in `packages/protocol`). Tapping it opens a sheet with the
  `Model` and `Reasoning effort` lists; a choice applies on tap through
  `mobile.agentChat.configure`, which forwards `agentChat.configure` and therefore the same
  validation against `models`. Like the Desktop menu, the sheet shows a choice at once
  (`agentChatSelectionView` in `packages/protocol`), so a new model's efforts list before the next
  snapshot arrives, and a failed switch reverts with an error in the sheet that clears once the
  Chat's choice or the connection changes (`agentChatConfigureScope`). While the snapshot reports
  `ultracode`, the sheet adds the Desktop menu's `Ultracode` switch below the efforts, and the
  trigger reads `Ultracode` after the effort while it is on. A new Chat can be
  configured before its first message. During a turn the sheet says `Applies to the next turn.` A Claude Code Chat that has not named
  its model yet asks for a model before it lists efforts. A provider without a model list, a
  `view` device, or a stale connection shows the model as plain text; an open sheet stays open with
  its lists disabled and the composer's reason.
- Beside the model, the composer shows a shield chip with the permission level in the Desktop
  picker's names (`agentChatPermissionModeLabel`, so Codex reads `Default`; `Custom` while launch
  settings match no level) and `Plan` while plan mode is on, only while the level differs from the
  provider's default (`acceptEdits` for Codex, `ask` otherwise) or plan mode is on, so a Chat at its
  defaults shows one chip instead of two. Full access keeps its alert shield in the ordinary text
  color, as Desktop's trigger; only the sheet's Full access option keeps the warning tone. The model
  chip and the shield chip open one `Chat settings` sheet; the shield chip opens it scrolled to its
  `Permissions` section, which lists the provider's levels with their descriptions and, except for
  Grok Build, a `Plan mode` switch; both go through `mobile.agentChat.configure { permissionMode,
planMode }`. A Codex switch during a turn says it applies to the next turn. "Use as Project
  default" stays on Desktop. Without `control` access, or offline, the level is a plain label; the
  saved copy keeps it so it still shows offline.
- Roles: `view` reads; `reply` also sends, deletes, steers with, or resumes queued messages, switches the model, effort, and ultracode, and retries a failed Chat; `control` also answers
  approvals and questions, switches the permission level and plan mode, and stops a turn or a background task. Mutations resolve the Terminal through the device's
  granted Projects, refuse a non-Chat Terminal with `CONFLICT`, and go through Core's mutation
  admission like a Desktop request. Retry restarts only a `failed` Chat (`terminal.restart` with
  `mode: 'resume'`).
- Requests. The phone docks one pending approval or question at a time above its composer
  (`agentChatRequestDock`), with `1 of N` while others wait; the dock takes at most 80% of the Chat
  so the timeline keeps room. A card keeps its title and buttons fixed and scrolls only its middle:
  an approval's text, or a question's options. A question shows its tabs (`Q1 Q2 Q3` and `2 of 3`),
  header, and text clamped to three lines with Show more above compact option rows (a radio glyph,
  two lines of description, and Desktop's `Recommended` badge from `agentChatQuestionOption`).
  A typed answer starts as an `Other…` row that opens a field whose return key answers. A tap on an
  option answers, so one question with options has no Submit; a typed answer shows Submit, and
  several questions step with Back, Next, and Submit (`agentChatQuestionFooter`). While the
  keyboard is up the header hides and the question clamps to two lines, and while the typed answer
  has the keyboard the options step aside. Code lives in
  `apps/mobile/src/features/agent-chat/agent-chat-question-form.tsx` and
  `agent-chat-request-flow.ts`.
- Images. A `reply` or `control` phone attaches up to 20 images (20 MB together) from the library, camera, or
  clipboard when the provider has `capabilities.chatImages`; Grok Build's composer has no attach
  button. The phone compresses each to a JPEG (at most 3 MB) and also makes the thumbnail Desktop
  would (fitted to 384 px, at most 48 KB), and uploads both through the Terminal composer's chunked
  `mobile.image.upload`. `mobile.agentChat.send` names each pair by attachment id; the gateway reads
  the uploaded bytes back through `mobile.image.readInternal` (same device, generation, and
  Session) and forwards an ordinary `agentChat.send`, so the provider sees the same message a
  Desktop paste produces.
- A thumbnail would exhaust the 48 KiB window by itself, so the window replaces a user message's
  image list with empty placeholders that keep only the count. The phone fetches each thumbnail on
  render, and the original on tap, through `mobile.agentChat.readImage` (item id, image position,
  `thumbnail` or `original`), in 45,000-character chunks so no frame overflows. A resumed Claude Code
  message has no thumbnail, so its tile shows the original instead, as Desktop rebuilds the preview. Originals come from
  `agentChat.readImage`, so they reach exactly the images Desktop can reopen. When the record no
  longer holds an original, the viewer enlarges the thumbnail and says the full-size image is not
  available; only an image with neither reads "This image is no longer available.". The gateway caches the last two originals for a minute so
  paging one does not re-read the transcript per chunk. The phone keeps thumbnails in memory and
  writes an opened original only to its cache directory for display.
- Sessions list approvals: a waiting Chat Session shows its first pending request as the same card the
  Chat docks above its composer, under its row, answered through `mobile.agentChat.respond`
  (control devices only; `view` and `reply` devices read the card and its access notice). The list
  polls `mobile.agentChat.requests`, a read every role may call that reads only Core's in-memory
  projection (`agentChat.pendingRequests`), so polling never starts or resumes a provider. A Chat
  never shows the "handled in Terminal" link; that link is for PTY Terminal Agents only. A
  file-change card in the list names no files (the timeline item that carries them is not sent);
  open the Chat to read them.
- Follow-up queue: `mobile.agentChat.send` forwards the phone's `delivery`, so a message sent during
  a turn steers it by default (`delivery: 'steer'`), like Desktop's Enter; holding the button, or
  the `Queue` button shown beside it during a turn, sends without `delivery` so the message joins
  the queue, the stand-in for Cmd+Enter (`agentChatComposerPressDeliveries`). With no turn running
  a tap sends normally, and the Server still queues it while the Chat compacts or drains its queue. The snapshot and `state` patches carry the queue
  as a bounded preview (`clipAgentChatQueueForMobile`: the first 10 entries, each text and command
  argument cut to 200 characters behind `…`) plus `queuePaused` and `queueLength`, the real count
  the header shows when the queue outgrows the preview; each entry keeps its real id. The phone shows it as a card docked above its composer with Desktop's header words (`Queued · sends
after this turn`, or `Queue paused · sends nothing until you resume` with Resume). Each row offers
  Steer (`Send now` on an idle Chat; disabled for a command during a turn) and Edit; swiping the row
  left reveals Delete, which only a tap removes, and a screen reader reaches it as a row action; these call `mobile.agentChat.sendQueuedNow`, `mobile.agentChat.takeQueued`,
  `mobile.agentChat.removeQueued`, and `mobile.agentChat.resumeQueue`, which forward the matching
  `agentChat.*` method after the
  same Terminal and grant checks as `send`. The row hides at once and returns with an inline error
  when Core refuses; that error clears once its row or the whole queue is gone. Rows are named by
  `agentChatQueueEntry`, which Desktop shares. Edit gets the full text the preview cut from
  `agentChat.takeQueued`, puts it ahead of the draft, and focuses the composer. A message with
  images or file and folder references is edited in place instead, as on Desktop: Edit first calls
  `mobile.agentChat.readQueued` (the full text the user typed with the reference block split off by
  `agentChatQueuedTextEdit`, the image count, and whether references ride with it), then the row
  becomes an editor showing only that text and "N images attached"; Save calls
  `mobile.agentChat.editQueued`, and the gateway puts the message's own reference block back ahead
  of the text before forwarding `agentChat.editQueued`, so references stay attached and images stay
  on Server Core. A failed save keeps the editor open with the typed text. The gateway first
  checks the text against the 16 KiB a phone may send, so a longer message stays queued for the
  computer; that refusal, and an entry that left the queue first, show as an alert, because the
  row is already gone from the card. While a turn runs the main button reads `Steer message` with Desktop's
  steer glyph and the placeholder reads `Add to this turn`.
- Sent messages. A long press opens Copy Message, Select Text, and on a user message "Edit from
  Here" (see [Mobile Design](mobile/design.md#conversation)). `mobile.agentChat.readMessage`
  returns a message's whole text from Core's projection (a user message split by
  `agentChatQueuedTextEdit`, as a queued edit is), bounded by the same 16 KiB; a message outside the
  projection is `NOT_FOUND`, and the phone then copies the text it holds unless that is only a
  tail. `mobile.agentChat.rewind` forwards `agentChat.rewind` with `restoreFiles: false` and the
  message's own reference block put back ahead of the edited text; the gateway refuses a message
  with images with `CONFLICT`, since its images could not ride along. It carries the sending grant.
- Background work. The snapshot and `state` patches carry the Chat's `tasks` as a bounded copy
  (`clipAgentChatTasksForMobile`: every running task up to 24, the newest started kept, and the 10
  that ended most recently, with titles and command lines cut to 300 characters and summaries to
  200). Above its composer the phone shows one status row: the turn's activity
  leads with a badge of the running work's kinds and counts beside it, and once the turn ended the
  running work leads the row (`Still running in the background: bun run dev`, or
  `2 background tasks running`). What counts as running follows Desktop's strip rule
  (`agentChatTaskStripView`, shared from `packages/protocol/src/agent/agent-chat-tasks.ts` with
  the elapsed time and Stop rules), so a Chat without tasks (Grok Build) shows none, and the badge
  disappears once nothing runs. Tapping the badge, or the row once the turn ended, opens a sheet listing running
  and ended tasks with their glyph, title (a command line in monospace), elapsed time, and status;
  a task opens its detail in the same sheet: the command, the provider's summary, and a shell's
  output tail or a subagent's latest message. A background command row's detail shows the same
  live section for the task it started. The detail reads `mobile.agentChat.readTask`, which
  forwards `agentChat.readTask` and cuts the reply to one frame
  (`clipAgentChatTaskSnapshotForMobile`: the output's last 24 KiB, measured as sent, and a
  subagent's newest items), every 1.5 s while the task runs and the app is in the foreground,
  instead of subscribing to `agentChat.taskPatch`. A `control` device gets Stop beside each running
  task the provider can stop (`mobile.agentChat.stopTask`, forwarded to `agentChat.stopTask`),
  which shows `Stopping…` until the Chat reports the task ended. A saved copy shows no badge, since
  its tasks may have ended long ago. Code lives in
  `apps/mobile/src/features/agent-chat/agent-chat-status-row.tsx`, `agent-chat-task-sheet.tsx`,
  and `agent-chat-tasks.ts`.
- Optimistic sends. Desktop and the phone share the placement and settlement rules in
  `packages/protocol/src/agent/agent-chat-pending.ts`: a sent message shows at once where it lands
  (the timeline when it starts or steers a turn, the queue otherwise) until the projection shows a
  new user message or queue entry containing its text, bounded by a 30 second TTL after the send is
  accepted. The phone also settles on the bounded copies it receives, matching the part a clipped
  text kept. A pending queue row on the phone offers no actions until Core has queued it. Slash
  commands, edits, and rewinds on Desktop still wait for Core, since Core can refuse them.
- Slash commands and skills: typing `/` or `$` at the start of the phone's Chat draft opens the
  same menu as Desktop: the snapshot's `commands` under Commands, then the skills discovered for the
  Chat's Terminal under Skills, matched on name and description with `searchAgentActions` and led by
  the group the sigil names (a scrolling list of about six visible rows). Skills come from
  `mobile.agent.actions` with the typed name as `query`, asked only while the draft is a bare
  invocation and the phone is connected and in the foreground; Server Core ranks the Terminal's
  whole action list with the same search before keeping its top 40, so a skill past the first page
  is still found. The menu shows `Loading skills…` until the first answer, and a quiet note when the
  Agent is not running (`UNAVAILABLE`). A skill the provider already lists as a command keeps its
  command row. A command without `argumentHint` runs when tapped; one with arguments, and every
  skill, fills the draft with the invocation and a space for the user to finish. The phone's copy of
  `commands` keeps every name but cuts descriptions to 120 and argument hints to 60 characters
  (`clipAgentChatCommandsForMobile`), so Claude Code's full skill list does not crowd the transcript
  out of the 48 KiB window. Submitting a draft that names a listed command calls
  `mobile.agentChat.runCommand`, which forwards `agentChat.runCommand` after the same checks as
  `send`, with its arguments held to the 16 KiB a phone may send; during a turn Core queues the
  command; like Desktop's, the command waits for Core instead of showing optimistically. Draft parsing and the menu model (`agentChatSlashQuery`, `parseAgentChatCommand`,
  `agentChatMenuActions`, `agentChatDraftMatches`, `completeAgentChatAction`) live in
  `packages/protocol/src/agent/agent-chat-commands.ts`, shared with Desktop; the ranking
  (`searchAgentActions`) lives beside it in `agent-action-search.ts`.

## Images and slash commands

- **Images.** A provider with `capabilities.chatImages` (Codex and Claude Code) accepts up to 20 PNG,
  JPEG, GIF, or WebP images per message, at most 5 MB each and 20 MB together, pasted, dropped
  anywhere on the Chat, or chosen with Files and folders in the composer's `+` menu. 5 MB is the Anthropic
  API's per-image limit; 20 images stays under its stricter 2000 px dimension rule for requests with
  more than 20; and 20 MB keeps the worst-case payload where four full-size images already put it,
  inside the API's 32 MB request limit once base64 adds a third. Server Core enforces the same count
  and combined size. An image alone is a valid message. `agentChat.send` carries each
  image's base64 data straight to the provider (Codex `image` data-URL input, a Claude `image`
  content block) and never stores it. The projection keeps only the Renderer-made JPEG thumbnail (at
  most 48 KB, raster data URLs only), which counts against the text budget. Codex pairs it with the
  echoed user message through `clientUserMessageId`. A resumed Chat knows how many images a message
  had, but their previews were the sending Client's. Both providers keep each image inline in their
  on-disk record: Claude Code's transcript under the user record's `uuid`, and Codex's rollout in
  the user message's `item_completed` event, whose `id` is the item id the app-server reports live
  and on `thread/resume`. The Renderer reads the original back with `agentChat.readImage` (message
  item id and image position; no provider process is needed, so a suspended Chat works too), makes
  the same thumbnail, and caches only the thumbnail. A Codex `localImage` input keeps its position
  but is never read, since its path was never authorized by the Session. An image the record no
  longer holds stays a placeholder, as does a Grok image.
- **Inline image placeholders.** An attached image is written into the draft at the caret as
  `[Image #N]`, the placeholder the Claude Code and Codex TUIs use, and the composer draws it as an
  atomic pill with the thumbnail, as Cursor draws a file mention; the tray thumbnail carries the
  same `#N` badge, as Orca's does, and clicking a pill opens the preview. `N` is fixed while the
  draft is written, so removing image 1 leaves image 2 named 2. Deleting a pill removes its image,
  removing an image from the tray removes its pill, and undo brings both back
  (`agent-chat-image-placeholders.ts`). At send the placeholders are renumbered 1..k in the order the
  images are sent, which is the numbering the Agent reads: Claude Code receives the text block
  before its images, as its TUI sends them, and the queue renumbers a joined message's placeholders
  past the images of the messages before it (`packages/protocol/src/agent/agent-chat-image-tokens.ts`).
  The sent bubble draws each placeholder that names one of its images as the same pill.
- **Other files and folders.** Files and folders in `+` opens the native open panel through
  `dialog.selectPaths`, which takes several files and folders at once (Chromium's file input cannot
  pick a folder together with files). It grants nothing, unlike the Project folder dialog, so a pick
  never widens what a Project may reach. When the provider takes images, Main returns each picked
  image's bytes (up to 64 MB across the pick) so it attaches as a dropped one would. An SSH Host
  window keeps Chromium's file-only picker as Files, since a path on this Mac means nothing to an
  Agent on the SSH Host, while a picked image still attaches. Every other picked file or folder,
  every file or folder dropped or pasted from Finder, and every file for a provider without image
  input such as Grok Build, becomes a card in the attachment tray beside the image thumbnails, as
  in the Codex app: an icon tile, the name, and `File` or `Folder`, with the full path in its
  tooltip (a dropped folder is told from a file because reading its first byte fails). Cards persist
  with the draft's images. On send the composer puts them ahead of the typed text in the Codex app's
  layout, `# Files mentioned by the user:`, one `## name: /absolute/path` line each (a folder's
  path ends in `/`), then `## My request for <provider>:` and the text
  (`agent-chat-path-references.ts`), so the Agent reads each from disk with its own tools and no
  file contents are inlined. Every Client parses that block back: the transcript, the pending row,
  the queue, the message rail, prompt history, Copy, Edit, and Fork show only the typed words, and a
  sent message shows each reference as a chip under its images. Clicking a chip calls the Desktop
  method `agentChat.openPathReference`, which opens a folder in Finder and reveals a file (or an
  app-like bundle such as `.app`, which opening would launch) in its folder. A Files entry, an
  Editor tab dragged with Option held, or a Project dragged from inside Caxri is inserted at the
  caret as its absolute path (shell-quoted only when needed), drawn as an atomic pill with its file-type icon and name; the
  message carries the path itself (`agent-chat-path-pills.ts`), a folder's with a trailing `/`.
  The sent bubble draws each whole-word absolute path as the same pill (a trailing `/` picks the
  folder icon) and opens it like a file link; a path with a `:line` suffix stays a file link. A
  Terminal drop still writes the path relative to where the Terminal stands. A video (`.mov`,
  `.mp4`, `.m4v`, `.webm`, `.ogv`) dropped, pasted, or picked from Finder is the exception to the
  card rule: it is cited at the caret as such a pill, drawn with its poster frame, so the video sits
  in the sentence where the user put it. The sent bubble keeps the pill in the text and adds a
  poster tile with a play button under any images, and clicking either opens a player dialog that
  plays and seeks the file, with Show in Finder when Chromium cannot decode it. Main serves the
  poster (a QuickLook thumbnail) and the video's byte ranges over the `caxri-media:` scheme only
  for an existing regular file whose path and resolved path both end in a video extension
  (`main/agent-chat/media-protocol.ts`). An SSH Host window treats a video like any other local
  file, since the Agent there cannot read it.
- **Caxri skill.** Caxri skill in `+` attaches a skill card to the tray (an icon tile, `Caxri
skill`, and `Skill`), so a request such as "open a Session for this" needs no prompt about the
  CLI. The row is a checkbox: choosing it again removes the card, and one message carries the card
  once. On send the composer puts `# Skills the user asked you to use:` ahead of any file block,
  one ``## caxri-cli: run `"$CAXRI_CLI" skills get caxri-cli --full` and follow it`` line, so the
  Agent loads the version-matched guide the CLI serves rather than a copy that could drift. The
  block parses back like path references: a sent message shows a `Caxri skill` pill instead of the
  instruction, and Edit, Fork, and a queued or failed message bring the card back.
- **Long paste.** Pasted text longer than the `agentChat.longPasteThreshold` setting (default
  32 KiB, `AGENT_CHAT_LONG_PASTE_THRESHOLD`, T3 Code's pasted-text attachment size), or any paste
  the 100,000-character message limit would otherwise cut, never enters the input. Raising the
  setting (up to the message limit) is how a user pastes a long log as is; a paste the message
  cannot hold is still saved, never cut. `agentChat.saveLongPaste` writes it through the same service and
  owner-only, pruned file store as [Terminal long paste](low-cost-generation.md#terminal-long-paste),
  and the composer inserts that reference where the paste landed. Send waits while a save is in
  flight. A paste past the 16 MiB file limit is refused with the Terminal's message, and one whose
  reference would no longer fit in the message is refused with a prompt to shorten it. A toast
  names the saved paste and offers Paste as Text, which replaces the reference with the text when
  it fits; Cmd+Shift+V pastes as text from the start, skipping the save.
- **List continuation.** Enter sends; Shift+Enter on a Markdown list line (`-`, `*`, `+`, `1.`,
  `1)`, or a `- [ ]` task) starts the next item with the same indent and marker, as the Codex app's
  composer does, and renumbers the ordered items below it. On an item with no text it ends the list
  instead. The edit goes through the editor's undo stack, so Cmd+Z takes it back.
- **Live Markdown preview.** The message input is a CodeMirror 6 editor whose document is the
  draft's exact Markdown, so what the Agent receives is byte for byte what was typed (no rich-text
  serializer escapes `snake_case` or `*`). Headings, bold, italics, strikethrough, inline code,
  list bullets, quotes, and fenced code render in place, as in the Codex app's composer and
  Obsidian's live preview; an element's syntax shows again while the caret or a selection touches
  it, and everything renders while the input is unfocused (`agentChatMarkdownMarks`). Offsets and
  the selection mean the same as a textarea's, so the key owners (stash, prompt history, menus, Goal
  mode, send) read the editor through a textarea-shaped adapter (`AgentChatComposerInput`). Text
  drags insert at the drop point; files, Option-held Editor tabs, and Projects still go to the
  pane's drop handlers, and an Editor tab dragged without Option moves into or splits the Chat's
  pane like a Terminal tab. The 100,000-character limit trims typed and pasted text as a textarea's `maxLength`
  did. A draft set from outside the editor (sent, restored, replaced) stays off the undo stack; an
  insertion such as a picked Session reference can be undone like typing.
- **Slash commands.** The snapshot's `commands` is the list the composer offers after a leading
  `/`. Codex lists `/compact`, which runs `thread/compact/start`; issued during a turn it waits in the
  queue. Codex also lists `/review [--base <branch> | --commit <sha> | instructions]`, which runs
  `review/start` inline on the thread (`review/codex-review.ts`): bare `/review` reviews the uncommitted
  changes, `--base` and `--commit` take exactly one value (a missing or extra one is a `VALIDATION`
  error before any request), and other text is custom instructions. Codex rejects an unknown branch or
  commit and its message is the command's error. The review is a turn, so it waits in the queue behind
  a running one. `enteredReviewMode` shows as a notice ("Reviewing current changes") and
  `exitedReviewMode` as an agent message holding the review's Markdown conclusion, so a resumed
  history shows both; target pickers and a dedicated results card are not built. Codex also lists
  `/goal` (see [Goals](#goals)).
  Claude Code reports its own list (built-in commands, skills, and custom commands) from the SDK's
  `initialize` response and `commands_changed`, minus the `terminal_slash_commands` that only make
  sense in its terminal UI; the command runs as prompt text, as in Claude Code itself.
- **`/new-session`.** Caxri adds its own `/new-session [next task]` row first for every provider; it
  hands the next task to a new Session and runs as a message, not through `agentChat.runCommand`. See
  [Hand off with /new-session](agent-delegation.md#hand-off-with-new-session).
- **Skills.** A leading `/` or `$` also lists the skills the
  [Agent Commands & Skills](agent-actions.md) picker discovers for this Terminal (`agentActions.list`,
  after the user's Settings overrides), ranked by the picker's search. Picker-only commands are
  left out because a Chat runs only what its provider reported, and a skill Claude Code already
  lists keeps its command row. Enter on a skill sends its invocation as the message; Tab inserts it
  and a space so a request can follow. In a running Codex Chat the list of skills is
  the answer to a `{"method":"skills/list"}` request, so enabled plugin skills appear and disabled ones do not; without a running
  process or when the call fails it falls back to the scan. A Codex `$skill` travels as ordinary text, which Codex
  resolves to the skill the same way its own composer does.
- **Recently used.** A bare `/` or `$` leads with a Recently Used group: the commands and skills
  last picked from this menu (Enter, click, or Tab) that it still offers, most recent first, as
  Claude Code's TUI ranks its own `/` menu by use. A pick goes through `agentActions.recordRecent`,
  so the Chat menu and the Agent Commands & Skills picker share the provider's eight recents. A
  recent row is not repeated in its own group, and typing a name ranks by the match alone. The
  phone menu does not lead with recents yet.
- `agentChat.runCommand` runs a listed command with optional arguments and rejects anything the
  Chat does not list with `VALIDATION`. In the composer, Arrow keys move through matches, Enter
  runs the highlighted command, Tab completes it so arguments can be typed, and Escape dismisses
  the list. Enter runs a command with an argument hint too, since those hints are mostly optional;
  only `/goal` switches the composer into Goal mode instead. While the Chat cannot send yet, Enter
  inserts the row like Tab, ready to send once it can. A command leaves the input as
  soon as it runs, as a message does, while Send says it is sending; if Server Core refuses it, a
  toast says why and the command text comes back into the input.
- **Session references.** Typing `@` at the start of a word lists other Sessions with an Agent
  conversation, searched by title. Choosing one replaces the typed `@word` with a reference to a
  condensed copy of that conversation, shown in the composer and the sent message as an atomic
  `@<title>` Session chip while the Agent receives the reference file and its sentence; see
  [Citing another Session](session-conversation-context.md#citing-another-session-with-).
- Image bytes, thumbnails, and command arguments never reach logs.

## Goals

A goal is an objective the provider keeps working toward across turns. Codex has native goals
(app-server `thread/goal/*`), so a Codex Chat lists `/goal` and reports the snapshot's `goal`
(objective, status, tokens, and the time Codex has counted). Claude Code's built-in `/goal` (the
command list's `builtin` row, not a same-named skill) also carries the goal mark, so choosing it
enters Goal mode and Enter sends `/goal <condition>` as prompt text. The list below describes Codex;
[Claude Code goals](#claude-code-goals) follows it.

- `/goal <objective>` sets the goal, and `/goal pause`, `/goal resume`, and `/goal clear` act on it,
  as in the Codex CLI (`parseAgentChatGoalArguments`). Bare `/goal` is refused. Every change carries
  `origin: "user"`, which Codex records in the conversation as the user's authorization. A new
  objective replaces a goal that is not complete by clearing it first, because setting an objective on
  an existing goal edits it and keeps its time and tokens.
- Codex starts each turn that pursues an active goal on its own: on `thread/goal/set` while the thread
  is idle, and again after every turn until the goal completes, is paused, stalls (`blocked`, after
  turns that made no progress), or hits a usage or token budget limit. Server Core never sends
  `turn/start` for it; the turns arrive through the usual `turn/started` notifications.
- A goal change is not a turn, so `/goal` runs at once even during a turn and never waits in the
  follow-up queue (`AgentChatProviderSession.isImmediateCommand`). Pausing or clearing lets the
  running turn finish; Codex only stops starting new ones.
- Stop pauses an active goal before it interrupts the turn, as the Codex CLI does. Otherwise Codex
  would start the next turn for the goal as soon as the interrupted one ended.
- `thread/goal/updated` and `thread/goal/cleared` keep `goal` current. Opening a thread reads it with
  `thread/goal/get` after the history replay, whose `reset` drops it, so a resumed Chat shows its goal
  again. `goal.updatedAt` is when Server Core received the report: Codex counts time only while a turn
  works on an active goal and reports it at turn boundaries, so a Client adds the running turn's time
  since the later of its start and that report (`agentChatGoalElapsedSeconds`).
- Server Core also counts the goal's spend across its turns in the snapshot's `goalUsage` (requests,
  tokens, and estimated cost, like `turnUsage`, named by the objective): `ChatTurnUsage` adds each
  response to it while the goal is active and starts over when another goal is set; the reducer drops
  it with a cleared goal, so the same objective set again counts from zero. It lives only in the
  Chat's snapshot, so a restarted Chat or Server Core counts from the next response, while the goal's
  time still comes from the provider. Both providers fill it, so it
  stands in for Claude Code's goal, which reports no tokens, and for Codex's `tokensUsed`, which
  counts tokens its own way and arrives only at turn boundaries.
- Desktop shows the goal as a row in the composer strip and enters Goal mode from `/goal` or the Add
  menu (see `DESIGN.md`). While a turn works on an active goal, the goal row shows that work live
  with the goal's time and `goalUsage`, in place of the status row (`agentChatLiveGoalActivity`). The
  phone runs `/goal` as a command and shows a goal row of its own (the objective, the goal's time,
  and Pause or Resume; tapping the row shows the whole objective with Clear, which confirms in a
  sheet) beside its status row, without `goalUsage`.

### Claude Code goals

Claude Code streams no goal state to the SDK: its `active_goal` frames stay internal outside remote
sessions, and its `goal_status` attachments reach only the transcript (verified with Claude Code
2.1.304). Server Core keeps the snapshot's `goal` from what it does stream (`ClaudeGoals` in
`apps/server/src/domains/agent-chat/goals/claude-goals.ts`):

- The `/goal` replies (`parseAgentChatGoalReply`): `Goal set:` and `Goal active:` show the goal as
  `active`; `Goal cleared:`, `No goal set`, and Claude Code's `Goal cleared after an unrecoverable
error` warning drop it.
- `/goal <condition>` is one query that keeps going while the goal's Stop hook finds the condition
  unmet, so a turn that completes with no background work left to wake Claude Code passed that check,
  and the goal leaves. An interrupted or failed turn, one waiting on background work, and one that
  only printed the goal's status keep it, with the turn's time added to `timeUsedSeconds`.
- The goal carries `pausable: false`, so no Client offers Pause: Claude Code's `/goal pause` would set
  a goal named `pause`. Clear sends `/goal clear`.
- Claude Code's SDK mode holds a slash command until the running query ends (only its interactive
  `/goal` runs beside a turn), and the goal's query runs until the condition is met, so a clear that
  waited in the follow-up queue would never land. While a goal is set and a turn runs, `/goal clear`
  stops that turn (labeled as the user's Stop), waits for it to end, and then runs at once
  (`AgentChatProviderSession.stopsTurnForCommand`); the follow-up queue is not paused, so queued
  messages go out after the clear. Without a goal, `/goal clear` waits like any other command.
- A Chat reopened from history (a Server Core restart, or a switch from the Terminal) reads the
  transcript's goal records in order (`claude-history.ts`): a `goal_status` attachment with
  `met: false` (written when the goal is set and after each check that found it unmet) or a
  `Goal set:` reply keeps the goal active, while `met: true`, `failed: true`, `Goal cleared:`, and
  the error warning drop it. A goal still active at the end comes back as the snapshot's `goal`
  without Pause, its `timeUsedSeconds` summing the replayed durations of the turns opened after it was
  set.

## Side chat

A side chat answers a quick question from the Chat's context without adding it to the conversation, as
Claude Code's `/btw` and `Cmd+;` do. It runs at once, even while a turn is running, and never
interrupts, queues, or steers that turn. Claude and Codex offer it (`capabilities.chatSideQuestion`);
Grok Build does not, and the PTY surface is untouched.

- **Entry points.** `Cmd+;` (`agentChat.openSideChat`, also in the command palette) and typing
  `/btw <question>` in the main composer, which asks in the side chat instead of sending a message (while
  the previous question is still being answered the draft stays and the composer says so), and the
  composer `+` menu's Side chat row. The
  side chat opens as a tab beside the Chat, in the same side pane task tabs use
  (`caxri-agent-side-chat://<terminalId>`, one per Chat), with its own composer and multi-turn
  follow-ups.
- **No persistence.** The thread lives only in Renderer memory (`agent-chat-side-chat-commands.ts`).
  Closing the tab keeps the thread, so reopening the side chat for the Chat shows it again; it is forgotten
  once the Chat is gone. There is no sidebar row.
- **Convert to Session.** The header action creates a new Session in the same Project with a Chat of
  the same provider and sends the answered Q&A as its first message; the thread is discarded once the
  new Chat accepted it.
- **Method.** `agentChat.askSideQuestion {terminalId, question, history}` returns `{response}`. The
  Client sends the earlier answered exchanges as `history` (at most 20). The method never starts a
  provider: a Chat that is not running answers `UNAVAILABLE`, and a provider without the capability
  answers `VALIDATION`. Caxri Bot refuses it (`caxri-bot-policy.ts`).
- **Claude.** The SDK query's `askSideQuestion` (a runtime method missing from the published types)
  sends a `side_question` control request with the history; the answer comes from the live session's
  context without a turn.
- **Codex.** Server Core forks the thread with `thread/fork` (`ephemeral`, `excludeTurns`, read-only
  sandbox, approval policy `never`), runs one `turn/start` on the fork, collects the final agent
  message, and releases the fork with `thread/unsubscribe`. While the main turn runs the fork goes
  through the last finished turn, because Codex refuses to fork a turn in progress. Fork
  notifications are routed before subagent task detection so the fork is never adopted as a task.
- **Log.** `agent_chat.side_question` records the closed outcome `answered`, `refused`, or `failed`, a
  closed reason (`unsupported`, `notRunning`, `timeout`, `empty`, `providerError`), the history length,
  and the duration. The question and answer text are never logged.

## Context usage and cache

The snapshot's `usage` (`packages/protocol/src/agent/agent-chat-usage.ts`) describes the context
as of the latest model response. Besides the total and the model window it can carry:

- `breakdown`: what fills the window. Claude Code answers `getContextUsage({ detail: 'summary' })`
  after every model response, mid-turn included, and once more when the turn ends (local
  estimates, no extra token-count requests; Claude Code 2.1.296 answers in milliseconds while a
  tool runs). Requests coalesce so at most one is in flight (`ClaudeContextRefresh`). The Chat
  keeps its `used` and `buffer` rows (system prompt, tools, memory files, messages, the autocompact
  reserve) and drops free space and deferred tool schemas; the previous rows stay until the fresh
  answer replaces them, so an open meter never collapses to the total during a running turn, and an
  answer that arrives after the total moved again is discarded. Codex reports its last request's
  cached input, new input, and output (reasoning is already part of output). Grok Build reports
  none.
- `compactWindow`: the window Claude Code compacts against (`rawMaxTokens`) when it is smaller
  than the model's, as with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or the 200K boundary on a 1M model.
  The meter's percentage and color measure against it: `--warning` with the percentage from 85%,
  and never `--danger`, because a full context is advice to compact, not a failure.
  The composer meter and the Context tab round the same whole percentage, and name a compaction
  point only while Claude Code reports auto-compact on (`isAutoCompactEnabled`).
- `cacheTtlMinutes` and `lastResponseAt`: how long the prompt cache survives an idle Chat, counted
  from the latest response. Claude Code's lifetime comes from the response's cache-write split (any
  one-hour write means 60 minutes, otherwise five-minute writes mean 5) and defaults to 60. Codex
  reports no lifetime, so it follows the sign-in that `account/read` reports at start (and
  `account/updated` after a change, `CodexUsage`): a ChatGPT sign-in has none, because OpenAI keeps
  signed-in Codex users' cache with no expiry, so its Chat never shows a cache notice; an API key,
  Amazon Bedrock, or a Codex that cannot say keeps an estimated 30 minutes, OpenAI's default
  retention.
- `cacheRewriteUsd`: the standard API price of writing the whole context into the cache again,
  from the price list bundled with the build (`apps/server/src/domains/usage/pricing.ts`, the
  same LiteLLM data the Usage page uses) at the cache-write rate the lifetime selects. A
  subscription spends allowance instead, so this is an estimate of weight, not an invoice.

While no turn runs, the composer shows these as one row in the activity bar's place, judged on a
minute clock, once the context is worth warning about: a rewrite priced at $0.25 or more, or at
least 40,000 tokens for a model with no price. In the last 10 minutes of the cache lifetime (the second half of a lifetime shorter
than 20 minutes, so a five-minute cache does not warn the moment a reply lands), a `--warning`
countdown says when the cache expires and that replying now avoids rewriting the context. Once the
Chat has idled past the lifetime, a `--muted` notice says the next message rewrites the context and
what that costs. From 85% of the compaction window, a `--warning` notice suggests `/compact`. A cache
notice and the compaction notice can show at once, cache first. Dismissing a cache notice (its
control reads `Hide this notice`) hides it until the next reply arrives without cancelling anything;
the dismissal lives in memory only. While idle compaction counts down (it does not for a conversation that ended with its Session's merged
pull request, which Server Core skips), the row offers `Compact now`
when the provider reports a compact command, so the user need not wait for the same compaction.

The expired-cache notice also offers **Continue in new Chat**, the cheaper way out of a large cold
context. It opens a new Chat of the same Agent in the same Session and sends it a handoff prompt
(`agentChatHandoffPrompt`) naming the previous conversation, session ID, transcript path (from
`terminal.agentTranscript`), and working directory. The prompt has the new Chat dispatch one
subagent on a cheap model to condense the transcript before it continues, so the old context is
never loaded whole. An unsent draft travels with the prompt as the request to handle after
catching up, and leaves the old composer only once the new Chat accepted the prompt. A Chat with
no transcript on disk refuses with an error instead of opening an empty Chat.

### Context tab

The meter's card in a Workbench Chat offers **Details**, which opens a read-only Context tab
(`caxri-agent-context://<terminalId>`, `apps/desktop/src/renderer/src/features/agent-chat/context/`)
beside the Chat, the way task tabs open. It is Claude Code only, so the other providers' meter has
no Details button and the tab shows an unsupported notice. Codex records each request's input and
cache-hit tokens (`last_token_usage.cached_input_tokens`), but no cache writes (its
`cache_write_input_tokens` stays 0), no item-by-item window, and no prefix change to blame for a
miss, so the tab's main parts have no source. Grok Build describes neither the window nor each
request's cache usage. Caxri Bot window refuses
`agentChat.readContext` (`apps/desktop/src/main/caxri-bot-policy.ts`) and hides the button.

`agentChat.readContext` (`packages/protocol/src/agent/agent-chat-context.ts`,
`apps/server/src/domains/agent-chat/chat-context.ts`) returns one report with three parts:

- `composition`: the live `getContextUsage({ detail: 'summary' })` answer kept whole, including
  free space, deferred tool schemas, memory files, MCP tools by server (loaded or deferred),
  skills, slash commands, custom agents, and the conversation by message kind and tool. It needs
  the running process; a closed Chat, or one that does not answer within five seconds, reports
  history only. Reading a report never spawns a provider.
- `requests`: every main-thread model request replayed from the transcript on disk, newest
  1,000 (`providers/claude/context-requests.ts`). Records sharing a `message.id` collapse into one, and
  sidechain (subagent) and `<synthetic>` records are skipped. A `compact_boundary` record marks the
  next request as following a compaction. `isHistoryTruncated` says the transcript read was cut.
- `changes`: what the Server saw change between consecutive composition reads of this process
  (MCP tools, skills, memory files, or agents added or removed; system prompt or tools resized),
  newest 100 (`ClaudeContextTracker` in `providers/claude/context-report.ts`). Claude Code does not say why
  a cache missed, so these are the evidence the tab cites; they reset when the process restarts.

The Renderer derives everything else (`context/cache-analysis.ts`). A request breaks the cache when
the previous request's prompt minus this request's cache read is at least 2,000 tokens and more
than 5% of that prompt. Each break takes the first matching cause: a compaction, a model switch, an
idle gap longer than the cache lifetime, otherwise a prefix change, which names the changes recorded
between the two requests (30 seconds of slack for the composition read that follows a response).
The cached prefix that survived is drawn against the window's rows in request order, so the row
where the rewrite starts reads directly (for example "from MCP tools"). The rewrite cost uses the
same bundled cache-write price as `cacheRewriteUsd`.

The tab shows, top to bottom: headline tiles (window use and compaction point, the cache clock,
hit rate, misses and their cost); suggestions only when something stands out (`context/suggestions.ts`:
prefix breaks, a dominant tool result, a heavy MCP server, a large memory file); the window bar with
the latest request's cached prefix on the same scale; a per-request cache timeline with break and
compaction markers and a break table; a "How the window filled" chart (`context/turns/turn-analysis.ts`,
`context-turns-card.tsx`) that stacks the window after each request into the starting context and
what the user's messages, model output, and tool results added since, restarting at each compaction,
with the autocompact line, the largest single growth outlined, and the selected request's additions
(heaviest tools by name) read out above it, reachable with the arrow keys; and heaviest-first lists of the conversation, MCP servers,
skills, memory files, and custom agents. Window rows share their shade with the composer meter;
the autocompact reserve stays neutral because it is not content. Category names Claude Code reports
(System tools, MCP tools, Messages, and so on) are translated through a closed map
(`context/category-labels.ts`); a category the map does not know shows as reported.

## Model and effort

The snapshot's `models` lists the models the provider lets this Chat switch to, each with the
reasoning efforts it accepts (`efforts`, lowest first) and its `defaultEffort`; `model` and
`effort` report what the next turn uses. `agentChat.configure` switches either one. Server Core
validates the change against `models` first (`resolveAgentChatModelChange` in
`packages/protocol`), so a stale Client cannot send a model or effort the provider never listed;
switching to a model that does not accept the current effort falls back to that model's default,
or, for a model that names none, to the strongest effort it accepts that does not exceed the
current one.
A running turn keeps the model it started with.

Fast mode is a separate toggle below the efforts, as in the Codex app and Claude Code's `/fast`. A
model offers it when its `models` entry carries `fast` (with the provider's description, if any),
and the snapshot's `fast` reports whether it is on; it is present only when the provider reports
the state. `agentChat.configure { fast }` switches it, Server Core rejects turning it on for a model
without it, and switching to such a model turns it off. The trigger then reads "Fast" beside the
model. The trigger keeps its model and effort label while the menu is open. Fast and Ultracode
while on, like the Plan chip, show the pressed `--selection` fill, never the accent.

- **Codex**: a model offers Fast when `model/list` lists a `priority` (or `fast`) service tier,
  falling back to the deprecated `additionalSpeedTiers`. The toggle rides on the next `turn/start`
  as `serviceTier: "priority"`, or `"default"` to turn it off (a null tier would keep the thread's
  saved one), and `thread/start` and `thread/resume` report it back after a restart. A picker
  switch (Fast, model, or effort) is also saved as the default for new Chats through
  `config/batchWrite` (`service_tier = "fast"` or `"default"`, `model`, `model_reasoning_effort` in
  the user's `config.toml`), as the Codex TUI saves its picker, because a new thread starts from that
  config. Only the user-facing `agentChat.configure` saves; a benchmark's direct session switch does
  not. `agent_chat.defaults_saved` logs the outcome; `overridden` means a higher-priority config
  layer (a profile or a managed config) still wins.
- **Claude Code**: a model offers Fast when its `supportsFastMode` is true. The SDK reports
  `fast_mode_state` on the `initialize` response, the init message, and every `result`; `cooldown`
  counts as on. When it reports a plan, policy, or provider block (any `fast_mode_disabled_reason`
  other than `sdk_opt_in_required` or `pending`) the toggle is withdrawn. Claude Code serves Fast
  only on extra usage, but under the SDK it reports `sdk_opt_in_required` before checking the
  account, so the Chat also reads the process's `/usage` answer when it opens (and on each plan
  limits refresh): while `rate_limits.extra_usage.is_enabled` is false, a Fast mode that is off is
  withdrawn too, and one that is on stays so it can be turned off. A switch applies in place
  through `applyFlagSettings { fastMode }`.

- **Codex** lists models with `model/list` after the thread opens; a Codex that cannot list them
  still chats, and the composer then shows the model as plain text. `thread/start` and
  `thread/resume` report the thread's `reasoningEffort`, and a thread that never chose one runs at
  its model's default. App-server has no request that changes the model in place, so a switch
  rides on the next `turn/start` (`model`, `effort`), which Codex saves on the thread for later
  turns and for the next resume.
- **Claude Code** lists models in the SDK's `initialize` response. `value` (often an alias such as
  `opus`) is the identifier and `resolvedModel` the full model the init message then reports, kept
  as `resolvedId` so the two match. For the `default` alias ("Default (recommended)") the composer
  shows the model it resolves to instead: the name its description gives ("currently Opus 5.5"),
  else the named entry with the same resolved model, else plain "Default". A switch applies in place: `setModel`, and `effortLevel`
  through `applyFlagSettings`, which outranks the user's settings files without writing to them.
  An SDK-hosted init message carries no effort (only Remote Control bridge frames do), so the Chat
  registers read-only `UserPromptSubmit`, `PreToolUse`, and `Stop` hook callbacks and reports the
  main thread's `effort.level` from their input: the level Claude Code actually sends after
  settings, environment overrides, and model downgrades. Claude Code fills it only for a hook with
  a tool-use context, so `PreToolUse` and `Stop` always carry it and `UserPromptSubmit` only
  sometimes. Before the first turn ends, or a switch, the effort can be unknown.
  Ultracode (standing multi-agent Workflow orchestration) is a separate toggle, as in Claude
  Code's own `/effort` picker since 2.1.284: the snapshot's `ultracode` is present only while
  `get_settings` reports `applied.ultracodeAvailable` for the current model, and the model menu
  shows an Ultracode checkbox below the efforts. `agentChat.configure { ultracode }` sends it
  through `applyFlagSettings`. Claude Code turns ultracode off when `effortLevel` moves without an
  `ultracode` key, so an effort change carries the current ultracode along, and every switch reads
  `get_settings` back so a model without ultracode withdraws the toggle. Typing the `ultracode`
  keyword in a message still opts that one turn in, since the text reaches Claude Code verbatim.
- **Grok Build** lists models in the `session/new` or `session/load` result's `models`
  (`availableModels`, `currentModelId`). A switch applies in place with `session/set_model`, and
  the usage meter takes the new model's `totalContextTokens`. A model that sets
  `_meta.supportsReasoningEffort` lists its efforts in `_meta.reasoningEfforts` (highest first; the
  menu lowest first) with `_meta.reasoningEffort` as the default. The current effort is the
  `reasoning_effort` entry of the result's `configOptions`, and `session/set_config_option
{ configId: 'reasoning_effort', value }` switches it (the answer and a `config_option_update`
  carry the new `configOptions`); Grok Build keeps the effort across a model switch.

## Permission level and plan mode

The composer's permission picker sits beside the model picker. It switches the Chat's permission
level and, where the provider has one, plan mode. Levels are provider-neutral ids
(`agentChatPermissionCapabilities` in `packages/protocol/src/agent/agent-chat-permissions.ts`), but
a provider offers only the levels it runs natively; Caxri never emulates a level by answering
approvals itself. Server Core rejects any other level, or plan mode for a provider without it, with
`VALIDATION`.

| Level        | Codex                                                             | Claude Code                         | Grok Build                       |
| ------------ | ----------------------------------------------------------------- | ----------------------------------- | -------------------------------- |
| Read only    | `on-request`, `read-only` sandbox                                 | Not offered                         | Not offered                      |
| Ask          | Not offered                                                       | `permissionMode: default`           | Root `--permission-mode default` |
| Accept edits | Shown as "Default": `on-request`, `workspace-write` sandbox       | `permissionMode: acceptEdits`       | Not offered                      |
| Auto         | `on-request`, `workspace-write`, `approvalsReviewer: auto_review` | `permissionMode: auto`              | Root `--permission-mode auto`    |
| Full access  | `never`, `danger-full-access` sandbox                             | `permissionMode: bypassPermissions` | `agent --always-approve`         |
| Plan mode    | `collaborationMode: plan` on `turn/start`                         | `permissionMode: plan`              | Not offered                      |

The snapshot's `permissionMode` is the level the provider runs with. It is absent ("Custom" in the
picker) when the launch settings match no level, for example Codex with `--ask-for-approval
untrusted`; such a Chat keeps those settings until the user picks a level. The menu then lists a
checked `Custom (from launch settings)` row above the levels, so the trigger's "Custom" has a row
to point at. Picking a level closes the menu. Plan mode is switched from the composer's `+` menu, and
a Plan chip beside `+` shows it is on and turns it off; both share the permission picker's optimistic
selection. `planMode` is present only for a provider that has plan mode.

The keyboard reaches the same controls from the focused composer: `agentChat.changeModel`
(`cmd+/`) opens the model picker, `agentChat.changePermissionMode` (`cmd+.`) the permission menu,
and `agentChat.togglePlanMode` (`cmd+alt+p`) flips plan mode, with the Plan chip as its only
feedback. The first two follow Cursor's Agent input; Claude Code and Codex cycle modes with
`shift+tab`, which moves focus here. Each composer registers only the controls its provider offers
(`agent-chat-composer-commands.ts`), so a command is unavailable, hidden from the palette, and lets
its chord through (an editor's `cmd+/` comment toggle, for example) on a Terminal surface, another
tab, or a provider without that control. A menu opened this way returns focus to the composer when
it closes. Caxri Bot window runs the same three commands for its Chat.

A switch is saved on the Chat's Terminal (`terminals.chat_permission_mode`,
`terminals.chat_plan_mode`), so a restart, resume, or app relaunch starts with it. A level the Chat
only inherited from the launch settings is not saved until the user picks one, so toggling plan mode
alone leaves the Chat following the Settings autonomy switch. How it applies
mid-Chat differs per provider:

- **Codex** has no in-place request, so a level rides on the next `turn/start` as
  `approvalPolicy`, `approvalsReviewer`, and `sandboxPolicy`, which Codex keeps on the thread; a
  running turn keeps the level it started with. Because `sandboxPolicy` replaces the thread's whole
  policy and app-server resets omitted fields to defaults (verified on Codex 0.163: a bare
  `workspaceWrite` turns `network_access` off and drops the tmp exclusions), a switch to a
  workspace-write level also sends the `[sandbox_workspace_write]` extras (absolute `writable_roots`, `network_access`,
  and the tmp exclusions) that `config/read` reports for the Chat's directory. `thread/start` and
  `thread/resume` pass the saved level directly. Plan mode is app-server's `collaborationMode`, which names the model and effort it
  runs with: it is sent on every turn while on, and `default` is sent once to turn it off when the
  thread last ran in plan mode (as `thread/resume` reports or the last turn sent). Without a reported
  model plan mode cannot be sent, so the Chat shows it off and refuses to turn it on until Codex
  reports one. Codex's `plan`
  item shows as an Agent message marked `proposedPlan`, which is what makes it approvable (see
  [Approving a proposed plan](#approving-a-proposed-plan)). A real-Agent E2E ignores the choice and keeps its fixed read-only
  thread. Because a running turn keeps its level, a switch made during one says so: the menu notes
  `Applies to the next turn.`, and the trigger adds a `from next turn` caption until that turn
  ends.
- **Claude Code** switches in place with `Query.setPermissionMode`, so a level applies from the next
  tool call, including inside a running turn. The Chat always opens with
  `allowDangerouslySkipPermissions` so Full access can be chosen later. Level and plan mode are kept
  apart because Claude Code has one mode for both: approving `ExitPlanMode` carries a `setMode`
  update to the chosen level, so plan mode ends straight at that level and no tool call runs in a
  mode Claude Code picked; Caxri then turns plan mode off and saves that. A launch
  `--permission-mode plan` is not carried over; plan mode is only the composer's toggle.
- **Grok Build** always launches with an explicit level, `--permission-mode default` for Ask when
  neither the launch settings nor the Chat choose one. Without it Grok Build follows the user's
  `[ui] permission_mode` in `~/.grok/config.toml`, so an `always-approve` there would run tools
  unasked while the Chat reads Ask; with the flag Grok Build 1.0.62 still sends
  `session/request_permission` under that config (verified against the real CLI with the same
  argv Caxri uses).
- **Grok Build** fixes its permission at launch, so a level switch restarts the Agent on the same
  conversation (`session/load`) with the new options. A running turn would be cut short, so the
  switch fails with `CONFLICT` until it finishes. Input sent while the switch is pending waits for
  the restart and reaches the new process, never the one being stopped.

A Chat with no provider process (stopped or failed) only saves a switch and shows it; the next start
launches with it, so the switch never starts the provider by itself.

**Project default.** The menu's last row is a checkbox item. "Use as Project default" saves the
Chat's level and plan mode for that provider on its Project; once the Chat matches the saved
default the row reads "Project default" and stays checked. While the Project has a saved default for
the provider, a "Clear Project default" row below it removes that default (`chatDefault: null`), so
new Chats follow the launch settings again; Chats that already copied it keep their choice. While the level is Custom it stays
visible but disabled with `Choose a level to save it as the default`, since a default must name a
level. Caxri Bot window omits the row (`AgentChatHostCapabilities`). The default is stored
(`projects.chat_defaults_json`, `project.setChatDefault`). A new Chat copies it at creation, except a
"Fork from here" Chat, which inherits its source Chat's stored choice and falls back to the default
only when the source stored none. A Terminal switched to Chat for the first time copies the default
too; a Chat that already has a
choice keeps it, and changing the default never touches existing Chats. Without a default, a new
Chat follows its provider's launch settings. Caxri Bot window omits the row: its Chat
runs under Caxri Bot policy, which refuses Project writes.

### Approving a proposed plan

"Plans first and changes nothing until you approve" holds for both Agents, and both end a plan with the same
`Start with this plan?` card (`Start Building` / `Keep Planning`), but the mechanism differs because the providers differ.
Claude Code raises an `ExitPlanMode` approval request, which the Chat answers through `agentChat.respond`. Codex has no
such request (its TUI's `Implement this plan?` step is client-side), so Server Core orchestrates it:

- `mapCodexItem` marks the `plan` item's Agent message `proposedPlan: true`.
- `agentChatImplementablePlanId` names the one plan a Chat can still build: the latest finished proposed plan, while plan
  mode is on, no turn runs, and no user message came after it. The Desktop dock shows the shared approval card
  (`agentChatProposedPlanRequest`, shaped as an `ExitPlanMode` request with only the two buttons) for exactly that item.
- `Start Building` calls `agentChat.implementPlan { terminalId, itemId }`. In one Server step it re-checks the plan, turns
  plan mode off (saved as the Chat's choice, permission level unchanged), and sends `Implement the plan.`, so the next
  `turn/start` carries `collaborationMode: default`. A stale plan, or a second call, fails with `CONFLICT`.
- `Keep Planning` only dismisses the card in the Renderer (not persisted, so it can return after a restart); plan mode
  stays on.

Mobile shows the same card above the composer for exactly that item (`agentChatImplementablePlanId` over the Chat
snapshot, so Desktop and the phone cannot disagree). `Start Building` calls `mobile.agentChat.implementPlan`, forwarded to
`agentChat.implementPlan` (control devices only, like `mobile.agentChat.respond`); `Keep Planning` hides the card for that
plan in the phone's memory only.

## Lifecycle signals

A Chat begins its own launch generation with the Agent coordinator and synthesizes
`sessionIdentified`, `turnStarted`, `turnFinished`, `turnFailed`, `attentionRequested`, and
`attentionResolved` from protocol events. They take the same provenance path as authenticated
hook signals, but they do not depend on the provider's hooks setting. The coordinator skips
working-directory session discovery for an unbound Chat so it cannot claim an unrelated PTY
conversation.

A Claude Chat also registers in-process `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`
callbacks for `Bash` (`apps/server/src/domains/agent-chat/providers/claude/shell-hooks.ts`) and synthesizes
the same `shellToolStarted`, `shellToolFinished`, and `shellToolFailed` signals the Terminal hook
bridge reports. The `git worktree add` classifier is
one shared source (`apps/server/src/domains/agents/hooks/worktree-command.ts`) that the bridge
embeds, and `PreToolUse` waits (up to the bridge's 2 second budget) until Server Core captured its
before-snapshot. A Chat Session therefore follows a worktree its Agent creates under
`workbench.newWorktreeBehavior`, exactly as a Terminal Session does. A Chat does not report the
hook `cwd` as `agentCwd`: its transcript is located through `agentProviderStateRoot`, and a Bash
`cd` moves the hook cwd without moving the transcript, so Chat resume would break. Claude Code's
built-in `EnterWorktree` and `ExitWorktree` do move the transcript, so a separate `PostToolUse`
callback (`apps/server/src/domains/agent-chat/worktree/enter-worktree-hooks.ts`, matcher
`^(EnterWorktree|ExitWorktree)$`) reports the `worktreePath` or `originalCwd` of the SDK's tool
output as `agentCwd` on a `shellToolFinished` event, ignoring subagent calls (`agent_id`). Server
Core proves it against the Project's Git worktree topology, then follows it under
`workbench.newWorktreeBehavior` exactly as a Terminal does; `ExitWorktree` clears the divergence and
returns a Session still rooted on that worktree to its owning Project. The hook waits (bounded to 2
seconds) until the value is durable. Because the transcript now lives under the worktree's provider
directory, a Chat start or resume launches Claude Code in `agentProviderStateRoot`, so the
conversation is found again after a restart. Codex and Grok Chats
expose no blocking pre-tool callback and do not report these phases.

A Claude Chat whose turn ends while a background subagent, workflow, or shell task is still running reports
`turnFinished` with `agentBackgroundWork`, the same evidence the Terminal hook bridge derives from
Claude's `background_tasks`, so the Session stays running in the quiet background sub-mode instead
of turning unread. When the task list later drains without Claude Code starting a new turn, the Chat
reports a plain `turnFinished` for the same turn, which settles it. A background shell whose command
matches `agents.longRunningShellCommands` (a dev server) never holds completion; see
[Activity view](activity-view.md). Monitors are not listed as Chat tasks, so they do not hold it in a Chat yet.

## Observability

`agent_chat.process_started` (closed outcome `ready`, `failed`, or `abandoned` with its reason,
resume mode, duration; `outcome: refused, reason: capacity` when the Terminal limit stopped a start),
`agent_chat.process_exited` (closed end reason with lifetime aggregates of turns, server
requests, rejected requests, and dropped frames), `agent_chat.turn_finished` (status, duration,
`turnId`, and `startRequestId`, the `agentChat.send` request that started the turn or `null` when
the queue or another non-request path did),
`agent_chat.protocol_rejected` (closed reason, protocol method name), and
`terminal.surface_switched` (closed outcome, both surfaces, duration), `agent_chat.queue_changed`
(closed reason and queue depth), `agent_chat.delivery_checked` (request method and closed outcome
`delivered` or `unknown` after a turn request timed out), `agent_chat.task_finished` (task kind, final status,
background flag, duration), `agent_chat.rewound` (closed outcome `rewound`, `refused`, `failed`,
or `resendFailed` when the record was rewound but the restart or the edited message's send failed;
closed reason `capability`, `turnRunning`, `notTurnStart`, or `unknownMessage`; the error code;
provider, whether files were reverted, turns removed, duration through the restart and send),
`agent_chat.files_restored` (closed outcome `restored`, `refused`, or `failed`, the same closed
reason, the error code, provider, turns whose file changes were undone, duration),
`agent_chat.side_question` (closed outcome `answered`, `refused`, or `failed`, closed reason, history length,
duration), `agent_chat.forked` (closed outcome `forked`, `refused`, or `failed`, the error code when it did not
fork, provider, turns kept, malformed transcript lines skipped (Claude Code only), whether a failure
left the provider's forked record `orphaned`, duration), `agent_chat.subagents_reconciled` (closed reason `serverStart`, terminals marked stopped), and `agent_chat.fork_release_failed` (debug
level, closed reason `rejected`, `timedOut`, or `stopped` when Codex could not unsubscribe from a
fork it loaded). A refusal names its reason; a driver that lacks file restore although its catalog
entry offers it logs `failed` with reason `capability`. None of them carries
message text, command output, provider stderr, or protocol bodies.

Each provider process is one Agent Run with its own `context.agentRunId` (a new one on every start
or resume). Records written from the process's callbacks (turns, tasks, protocol rejections,
delivery checks, activity changes) carry that `agentRunId` as their `traceId` too, and drop the
identities of whichever request happened to start the process. `agent_chat.process_started` keeps
that request's trace and names the Agent Run, which links the two; `agent_chat.process_exited`
also names it. Only Server Core mints an Agent Run: request parameters never set `agentRunId`.

## Testing

`apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-app-server.ts` and
`fake-claude-cli.ts`, and `fake-grok-acp.ts` are deterministic stand-ins for each provider, selected by keywords in the
user's message (approval, file-change approval, edit, oversized diff, question, plan approval,
table, slow stream, subagent, background shell, Claude workflow, failure, crash). The Claude fake speaks the stream-json control protocol the
SDK drives and writes a real transcript, so resume is exercised end to end. Both answer a message
with images by counting them and implement compaction, so the E2E covers paste, file pick, and the
slash list for each provider. The Grok fake persists its frames so `session/load` replays them,
folding each tool call into one `tool_call` frame with its final status like Grok Build 1.0.50,
and takes no images. All three implement their provider's rewind (Codex `thread/revert`, the
Claude transcript chain with `--resume-session-at` and `rewind_files`, Grok `_x.ai/rewind/*`) and
log each call to a JSON-lines file in their state directory, so `service-rewind.integration.test.ts`
checks the request and the history a later resume reads. The Codex and Grok fakes also fork
(`thread/fork`, `_x.ai/session/fork`), and Claude forks through the SDK over the fake's real
transcript, so `service-fork.integration.test.ts` resumes each fork and reads its history. Unit, integration, and fake-mode E2E tests drive them; no test launches the
real CLI or calls a model.

The Claude and Codex fakes also play scripted turns: `FAKE_CLAUDE_SCRIPT` and `FAKE_CODEX_SCRIPT`
name a JSON file whose turns play when the sent message equals a turn's prompt, with a chosen model
name, thinking or reasoning, todos or a plan, tool calls and file diffs, an approval, a held running
turn, or a failure. A matched prompt bypasses the keyword scenarios; any other message keeps them.
`fake-claude-script.ts` and `fake-codex-script.ts` define the formats, and the fixtures'
`scriptPath` option sets the variable. The `promo-images` skill drives them to stage believable
Sessions for promotional captures.

Streaming Markdown has a machine-independent CI gate in
`packages/markdown/src/__tests__/streaming-parser.test.ts`: the incremental parse must equal a full
parse at every character of boundary-sensitive sources and at every delta of a long reply, parse
work must stay below 10x the reply length for both a mixed reply and one long list, and settled
blocks and list items must keep their identity across deltas.
`packages/markdown/src/__tests__/streaming-repair.test.ts` holds the repair to the same bar: it
matches the frozen rescan implementation byte for byte at every character prefix, and its scanned
characters stay below 10x the reply length. Wall-clock timing is a trend only:
`bun run benchmark:markdown` prints both the incremental and the full re-parse pipeline for both
replies.

`bun run test:e2e:real-agent` is the manual, never-CI smoke against the real CLI (see the `e2e-testing` skill). Its
Chat case runs under a real-Agent policy authorized for the Chat surface only: that run cannot open a PTY or Shell
Terminal, and the thread is pinned to a read-only sandbox with no approvals, ignoring the user's Codex launch
settings. It sends two short natural prompts, relaunches Caxri between them, and asserts only content-free signals:
Chat status, turn statuses, item counts by type, an unchanged `agentSessionId`, and the `agent_chat.process_started`
modes (`started`, then `resumed`) and `agent_chat.turn_finished` statuses from the Server Core log. It never reads,
logs, or captures reply text. The PTY smoke's policy, in turn, still refuses to start a Chat.

## Usage limits

A turn that failed on a used-up plan limit offers `Continue in <Agent>` and, when the limit resets
within a day, continues on its own after the reset; an account at 99% of its weekly window blocks
new requests behind the weekly usage guard, and a turn that guard stopped continues the same way
when the window resets within a day; see
[Usage limits and cross-Agent continuation](agent-usage-continuation.md).

## Not yet supported

Claude Code's agent picker (its `initialize` response already lists the agents). Grok Build's
plan mode and images (its ACP agent advertises `image: false`). Grok Build stays out
of the real-Agent smoke. On mobile, a
Chat shows no plan or context usage yet, cannot edit or fork from an earlier message, and older history beyond the window stays on
the computer.

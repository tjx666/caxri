---
kind: living
status: current
---

# Agent Chat

A Chat is an Agent Terminal created with the `chat` surface. It runs the user's own, unmodified
Agent CLI through the vendor's structured protocol and renders a conversation (streamed Markdown,
collapsible tool rows, approval and question cards) instead of a terminal grid. The decision and
its trade-offs are in [ADR 0012](adr/0012-agent-chat-surface.md).

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
  without being retained, and the stdin EOF, SIGTERM, SIGKILL stop escalation.
- `chat-items.ts`: bounded string helpers, closing dangling items, the operations for a process
  that ended, the `answered` notice, the replacement diff for a file edit, and the prompt text of a
  slash command that runs as a message.
- `JsonRpcConnection` (`json-rpc-connection.ts`): newline-delimited JSON-RPC over the child's
  stdio, shared by Codex (which omits the `jsonrpc` field) and Grok Build's ACP (which requires it).
  It bounds frame size and pending writes and ignores responses to requests it never sent.

| Provider    | Driver                   | Protocol                                                           |
| ----------- | ------------------------ | ------------------------------------------------------------------ |
| Codex       | `codex-chat-session.ts`  | `codex app-server --listen stdio://` JSON-RPC                      |
| Claude Code | `claude-chat-session.ts` | Claude Agent SDK streaming input over the user's own `claude` CLI  |
| Grok Build  | `grok-chat-session.ts`   | ACP (Agent Client Protocol) v1 over `grok agent --no-leader stdio` |

Adding a provider means a driver, its item mapping, its launch-settings translation, and a fake
CLI fixture; the service, reducer, and pane do not change.

## Surface and identity

- `terminal.create` takes `surface: 'chat'`; the default is a PTY. The surface is stored in the
  `terminals.surface` column; only a surface switch (below) changes it. `isChatTerminal` is the one
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
- The Agent Session (the Codex thread id, the Claude Code session id, or the Grok Build session id) is bound to the Terminal
  only when the first turn starts. Neither provider writes its record before that, so an earlier
  binding could never be resumed. An unbound Chat simply opens a new conversation on its next
  start. Claude Code is started with a preset `--session-id`, and Grok Build's `session/new` with a
  preset `_meta.sessionId`, so the id is known before the turn.
- PTY-only operations (Terminal input from other Clients, Agent dispatch, compaction, Git review
  sends, long pastes, mobile submits, suspension, restore) reject or skip a Chat through
  `apps/server/src/domains/pty-guard.ts` before any side effect. A phone drives a Chat through
  the `mobile.agentChat.*` methods instead; see [Mobile](#mobile).

## Switching surface

A Chat-capable Agent Terminal reopens on the other surface from the `Terminal | Chat` toggle on the
tab rail (shown for the active tab), its tab's context menu ("Open as Chat" / "Open as Terminal"),
or `terminal.switchAgentSurface` (`cmd+shift+j`, also in the command palette), all through
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
- "Copy Resume Command" in the tab and Session row menus copies `cd <cwd> && <provider resume
command> <id>` (`agentResumeCommandLine`, from the provider catalog's `resumeArgs`) to continue
  the bound conversation in the provider's own TUI outside Caxri. It is disabled until the Agent
  has a conversation.

## Process lifecycle

`AgentChatService` (`apps/server/src/domains/agent-chat/service.ts`) owns one provider child per
live Chat (`codex app-server --listen stdio://`, `claude` in stream-json mode, or
`grok agent --no-leader stdio`), spawned by Server Core. Its environment
(`prepareChatLaunch` in `apps/server/src/domains/agent-chat/chat-launch.ts`) is the same
secret-minimized base environment as other Agent launches (`agentCommandEnvironment`: the Server's
allowlisted variables, login-shell `PATH`, and the Agent `HOME`), but it omits both per-launch
additions a PTY Agent receives from `apps/server/src/domains/terminal/lifecycle-environment.ts`:

- No lifecycle-hook environment: the Chat synthesizes its own lifecycle signals, so hooks would
  double-report.
- No Agent Endpoint environment (`CAXRI_MANAGED_AGENT`, `CAXRI_AGENT_ENDPOINT_*`,
  `CAXRI_USER_DATA_DIR`, `CAXRI_CLI_PATH`): a Chat provider holds no Agent Endpoint credential, so
  `caxri` commands it runs do not act as a managed Agent identity, and provider hooks cannot use
  `CAXRI_MANAGED_AGENT` to recognize it as Caxri-owned.

- **Lazy start.** The provider starts on the first `agentChat.read` or `agentChat.send` (the one
  eager start is `session.resume` taking a detached Chat back; see Detach). Server
  Core restart therefore never relaunches idle Chats, and boot-time Terminal restore skips them. A
  failed or detached Chat does not start on a read, and neither does a Chat whose Session is
  archived or whose Project is hidden: the admission fence refuses it, and the first read after
  the Session returns to the Workbench starts it.
- **Resume.** A bound Chat resumes its thread with `thread/resume`, verifies the returned id, and
  rebuilds the projection from the returned history. `model` is omitted on resume so the thread
  keeps its own model and effort. A failed resume is a visible `resume_failed` failure, never a
  silent new thread.
- **Claude Code resume.** Claude Code does not replay a resumed conversation over the protocol, so
  the history comes from the bounded tail of its JSONL transcript, read through the same
  Server-derived path as `terminal.transcript`. Sidechain (subagent) and harness records are
  skipped, a visible user prompt opens a turn, and every resumed turn is finished. A missing
  transcript or a `--resume` that fails its handshake is `resume_failed`. The `answered` notices
  Caxri synthesized are not in the transcript, so they do not survive a resume.
- **Grok Build resume.** `session/load` replays the conversation as `session/update` frames before
  it answers, with `turn_completed` marking where each turn ended; the Chat folds them into one
  reset. An unknown session id fails `session/load`, which is `resume_failed`.
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
- **State.** `lastProcessState` and `lastAgentProcessState` follow the child: `starting`,
  `running`, `stopped` after an orderly stop, `detached` after a detach, `dead` after an
  unexpected exit, `failed` with a closed `failureReason` when it cannot start. Orderly Server
  Core shutdown stamps `interrupted` through the shared shutdown path, not completion.
- **Running count.** Live Chat children count toward `activePtyCount` and `terminal.runningCount`
  (whole app or one Session), so Server Core idle exit, `server.stop`, the window-close
  confirmation, and Session or Project deletion prompts treat them like live PTYs. Choosing
  Terminate and Close stops the Chat provider process with the PTYs and records it `stopped`;
  the Chat service keeps running, so the next read on the same Server Core starts it again.

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
inside Server Core without one. `claude-items.ts` holds the pure message mapping,
`claude-history.ts` rebuilds a resumed Chat from the transcript, and `claude-requests.ts` holds
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
  carries neither, since it finishes after the hand-off. Settling lives in `claude-tool-results.ts`.
- `Edit`/`MultiEdit`/`Write`/`NotebookEdit` is a file change whose diff is
  replaced by Claude Code's `structuredPatch` when the result arrives, `TodoWrite` the plan, and
  every other tool a generic tool row. Subagent frames (`parent_tool_use_id`, with
  `forwardSubagentText`) go to the subagent's own task projection, never the parent timeline; see
  [Background work](#background-work).
- Usage is the latest model request's input plus cache plus output tokens; the context window
  comes from the result's per-model usage. See [Context usage and cache](#context-usage-and-cache)
  for the breakdown, compaction window, and cache lifetime.

## Grok Build mapping

`grok-chat-session.ts` speaks ACP and `grok-items.ts` holds the pure mapping:

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
- Every patch carries `baseRevision` and `revision`. Server Core and every Client apply operations
  with the same reducer (`packages/protocol/src/agent/agent-chat-reducer.ts`); a Client whose
  revision does not match re-reads. Server Core flushes queued operations before each read so a
  snapshot never contains an operation a later patch would repeat. A restart or close drops the projection
  but never reuses a revision: the replacement starts one past the last revision, so a Client
  holding the old snapshot sees a gap and re-reads instead of discarding new patches.
- Bounds: 1,000 items, 64 KiB per message, 16 KiB of command output (the tail is kept), 64 KiB per
  diff, 1 MiB of diffs per file-change item, and a 4 MiB aggregate text budget. The budget also holds
  while a reply streams. Older items are dropped first and `truncated` is set. A diff cut by either
  diff bound carries its own `truncated` flag, so the pane marks where it stops.
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

Subagents and background shells are tasks: the snapshot's `tasks` lists each one (kind, title,
status, agent type, model, usage, the timeline item that started it, and whether it can be stopped),
and each task has its own projection (`AgentChatTaskSnapshot`) with its own revisions, patched by the
transient `agentChat.taskPatch` event exactly like the parent projection. A task projection holds a
subagent's conversation (500 items, 512 KiB of text) or a shell's output tail, so a chatty subagent
evicts only its own history. Server Core keeps at most 50 tasks per Chat (ended ones drop first) and
20 task projections in memory (ended ones are evicted first and rebuilt on the next read).

- `agentChat.readTask` returns the live projection, or rebuilds one from the provider's record for a
  task this process never saw (a resumed Chat, an evicted projection); `taskId` may also be the id of
  the timeline row that started the task, so a subagent row stays openable after a restart.
  `agentChat.stopTask` stops one task without ending the turn. A provider exit marks every running
  task stopped.
- **Claude Code.** A subagent's task id is its `Agent`/`Task` tool use id. Metadata comes from the
  tool call and the `task_started`, `task_progress`, `task_notification`, `task_updated`, and
  `background_tasks_changed` system messages. A background shell uses Claude's `task_id` and links
  its Bash row; its output tail comes from polling the SDK's `getTaskOutput` about once a second.
  `perTaskStopAffordance` keeps background subagents alive across an interrupt; a background shell
  outlives an interrupt either way, with no task event (verified with Claude Code 2.1.296). `stopTask`
  maps to the SDK's `stop_task`. History is rebuilt from
  `<session>/subagents/agent-<id>.meta.json` (matched by `toolUseId`) and its `.jsonl`.
- **Codex.** A subagent is a child thread; its task id is the child thread id and its row is the
  `collabAgentToolCall` (or `subAgentActivity`) item. App-server sends no `thread/started` for a
  spawned child, so notifications from an unknown thread are held briefly (8 threads, 500 each) until
  a spawn item names it. Stopping interrupts the child's turn; history comes from `thread/read`. A
  `commandExecution` with a `processId` still running when its turn ends becomes a shell task;
  Caxri initializes with `experimentalApi: true` so `thread/backgroundTerminals/terminate` can stop
  it. Codex stops streaming a command after 10,000 deltas, which sets `isOutputCapped`. A resumed
  thread lists each command its history still shows running in a finished turn as a stopped shell
  task ("Ended: Caxri restarted and can no longer track it"), since the app-server that ran it is
  gone; one `thread/backgroundTerminals/list` still reports is taken back running and stoppable.
- **Grok Build.** No tasks are projected yet: its background task updates are ignored, `stopTask`
  answers `CONFLICT`, and `readTaskHistory` knows no task.
- **Pane.** A subagent or background row opens its task in a Workbench tab
  (`caxri-agent-task://<terminalId>/<taskId>`, `packages/protocol/src/domain/agent-task-tab.ts`) in a
  split beside the Chat, reusing that side pane for later tasks. A subagent tab is a read-only
  timeline with its title, type, model, status, and Stop; a shell tab shows the command and its
  live output, titled by the command without Codex's login-shell wrapper. Running tasks also appear
  in a Background work list above the composer, where each opens or stops on its own; a finished
  task stays reachable from its timeline row.

## Follow-up queue

A message sent while a turn runs waits in Server Core's queue by default and goes out as its own
turn once the Chat is idle, one turn at a time and in order; a message also waits behind earlier
queued ones. `agentChat.send` with `delivery: 'steer'` instead adds it to the running turn (Codex
`turn/steer`, Claude Code `priority: 'next'`, Grok Build `_x.ai/interject`). A slash command issued during a turn is queued.
User messages record how they arrived (`delivery: 'queued' | 'steered'`). The mark lives in the
provider's own record, so a resume after a restart still shows it: Codex keeps it as the
`clientUserMessageId` prefix (`queued:<uuid>`) its user message echoes as `clientId`; Claude Code
records a steered message as a `queued_command` attachment, and a queued one carries a version-8
uuid whose third group is `8c01`. Grok Build keeps no mark, so its resumed messages show none.

- The snapshot's `queue` lists each entry's text, image count, and command; image data stays on
  Server Core. At most 20 entries and 256 KiB of text.
- `agentChat.interrupt` pauses a non-empty queue (`queuePaused`) so stopping a turn never fires the
  next message by surprise; `agentChat.resumeQueue` continues it. `agentChat.removeQueued` drops an
  entry and `agentChat.sendQueuedNow` sends one ahead of the rest (steering a running turn; a
  command cannot steer). A failed dispatch puts the entry back and pauses the queue.
- A Codex `turn/start` or `turn/steer` that times out may still have started the turn, so Codex
  Chat checks before failing: the user message's `clientId` echo, or `thread/turns/list` over the
  newest turns. A recorded message counts as delivered. One it cannot confirm fails as delivery
  unknown: the entry stays in the paused queue (Send now and Remove still work), and the timeline
  gets an `error` notice telling the user to check the conversation before sending it again, so
  nothing is sent twice automatically.
- The queue survives a restart of the Chat and goes out once the new process is ready; it is never
  persisted across Server Core restarts.
- In the composer, Enter queues during a turn and Cmd+Enter steers. Queued entries form one list
  above the composer, each with Edit (back into the composer), Delete, and Steer or Send now; a
  paused queue says so in the list header with Resume. Phones do not see the queue, so
  a message sent from a phone during a turn steers it, as before.
- Compaction (Codex `contextCompaction`, Claude Code `status: 'compacting'`) sets the snapshot's
  `operation` to `compacting` and raises `compactionStarted`; input sent meanwhile is queued. The
  `/compact` user bubble is hidden because the compaction notice already represents it.

## Edit from here

Hovering a user message that started a turn shows "Edit from here" beside Copy. It puts the
message's text into the composer (any draft is set aside) and opens the edit bar above the input:
how many turns sending replaces, an "Also revert file changes" checkbox, and Cancel (Escape), which
brings the set-aside draft back. The edited message keeps an accent outline. Sending calls
`agentChat.rewind`, which rewinds the provider's own record to just before the message and sends
the draft in its place as one request; a later resume shows the same shorter conversation. The edit
survives switching tabs, like a draft.

- Only a settled Chat rewinds: while a turn runs, the action and Send are disabled and say to stop
  the turn. A steered message did not start its turn, so it offers no edit, and a message with
  images cannot be edited, as with a queued message. Server Core checks the same rule
  (`agentChatRewindTarget` in `packages/protocol/src/agent/agent-chat-rewind.ts`) and answers
  `CONFLICT` when the Chat changed under the request.
- Reverting files can discard the user's own later edits to those files, so it asks first in a
  native dialog (`agentChat.confirmRevertFiles`); Cancel sends nothing and keeps the draft.
- Each provider rewinds with its native mechanism; Caxri takes no snapshots of its own.
  `capabilities.chatRewindFiles` says whether files can be reverted, and when they cannot, the
  checkbox stays disabled with the reason on hover.
- "Restore code to here" sits beside "Edit from here" for a provider that reverts files: it calls
  `agentChat.restoreFiles`, which puts back the files changed from that message onward and keeps
  the conversation, as Claude Code's `/rewind` "Restore code" does. It asks first in the same
  native dialog, follows the same running-turn and turn-start rules (a message with images can
  restore code, since nothing returns to the composer), and logs `agent_chat.files_restored`.
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
File checkpoints are taken only from prompts sent with checkpointing on, so a Chat started before
it was enabled, or a message older than the transcript tail Caxri reads, refuses to revert files
with the reason. Grok Build names a prompt by its index in the whole session, which the Chat may
not hold in full, so Caxri counts back from the newest of `_x.ai/rewind/points` and checks that the
point's preview matches the message before rewinding. Mobile does not offer the action.

## Fork from here

Beside "Edit from here", a message that started a turn offers "Fork from here". It copies the
conversation up to just before that message into a new Agent Session through the provider's own
fork, opens it as a Chat in a new Session of the same Project and cwd, puts the message's text in
the new composer, and selects that Session. The source Chat is not touched, and nothing is merged
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

| Provider    | Fork                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Codex       | `thread/fork { beforeTurnId }` (experimental), then `thread/unsubscribe`, since the new Chat resumes it elsewhere   |
| Claude Code | The Agent SDK's `forkSession({ upToMessageId })` at the record a rewind would resume at, over the Chat's own folder |
| Grok Build  | `_x.ai/session/fork { targetPromptIndex }`, the index a rewind takes; the new Chat opens it with `session/load`     |

The Agent SDK resolves Claude's settings folder from Server Core's environment, once per process,
while each Chat runs Claude Code with its own environment, so `forkClaudeSession` hands
`forkSession` a session store over that Chat's `CLAUDE_CONFIG_DIR` transcripts. Mobile does not
offer the action.

## Approvals and questions

Claude Code asks through the SDK's `canUseTool` callback, keyed by the tool use id. `Bash` is a
`command` request, file tools a `fileChange` request linked to their item, `AskUserQuestion` a
`question` (answers are returned keyed by question text), and any other tool the generic `tool`
request (`Allow WebFetch?` with its URL or arguments). "Accept for this Chat" is offered only when
Claude Code suggests a session rule and applies those suggestions; decline denies the tool and
marks its row declined.

Grok Build asks through `session/request_permission`, keyed by the tool call id; its permission
options (`allow_once`, `allow_always`, `reject_once`, `reject_always`) set the offered decisions,
and Skip or a decision with no matching option answers `cancelled`. Caxri turns on
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
  history never hides them. The plan stays one collapsed row (the current step and `done/total`)
  until the user expands it, so a long plan never pushes the transcript out of view. The timeline follows new output until the user scrolls up; Jump to
  latest returns to the end.
- The composer keeps an unsent draft per Chat across tab and Session switches and across a full
  restart, clears only the text that was actually sent, and treats Escape as Stop while a turn
  runs. The draft text is device-local Renderer state in `localStorage` (bounded to the 50 most
  recently edited Chats), never sent to Server Core; attached images stay in memory only, because
  a few encoded images would exhaust the storage quota. ArrowUp on an empty composer recalls the
  prompts this Chat sent, newest first, and ArrowDown walks forward and back to an empty input,
  like a shell. The history is read from the user messages in the Chat's projection, so it needs
  no storage of its own and reaches only as far back as the projection keeps (see
  `truncated`). ArrowUp is left alone while the input holds the user's own text, an image is
  attached, or the command menu is open for typed text; a recalled `/command` that opens the menu
  still walks on. A recalled prompt left in the input is an ordinary draft, so it persists like
  one and editing it ends the walk. Its action row shows how much of the
  context window is used, as a filling ring and a percentage with the token counts and what fills
  the window in its tooltip, and the model and effort picker (see "Model and effort" below). Activating a Chat's tab puts the cursor in the composer, as activating
  a Terminal tab focuses its grid, under the same rules: not behind a modal, not out of another
  text field, and not when arrow-key tab navigation activated it, which keeps focus on the tab.
  A status row at the top of the composer card says whether the Chat is starting, working, or waiting on an
  answer; a working turn shows one verb chosen per turn from its id, its elapsed time, and `Esc to
stop`, which is also a pointer shortcut for Stop. Only the label is the polite live region, so the ticking time is never announced.
- Work renders as one-line rows (`Ran git status`, `Read <file>`, `Edited <file> +2 more`),
  each with the tool kind's glyph from the provider tool table shared with mobile
  (`packages/protocol/src/agent/agent-tool-presentation.ts`). Codex's login-shell wrapper
  (`/bin/zsh -lc "..."`) is unwrapped so a row shows the script that ran. A command the Agent
  described (Claude Code's `Bash` description) is titled by that description, and its command line
  moves into the expanded view. A row shows its duration once it reaches a second, a non-zero `Exit N`, and a
  `Background` tag for a hand-off; the expanded view ends with its exit code. Codex reports no
  description or background state for a command, so its rows show the command line. Consecutive work collapses
  into one summary row, and once a turn ends its work and commentary fold behind `Worked for X`
  (`Stopped after X`, `Failed after X`), keeping the prompt, the final reply, and notices other than
  a transient retry in view. A running turn stays expanded, and running work sweeps a highlight across its verb instead of
  swapping its glyph for a spinner. A thought shows the latest bold title Codex opens a reasoning
  summary part with (`Thinking Planning the fix`). Expanded command and tool output is
  painted in the language inferred from what produced it: the extension of a file a `cat`/`sed`/
  `head` printed or a Read tool returned (with Claude Code's line-number gutter removed), `diff` for
  `git diff`/`git show`, or JSON; anything else stays plain text. Grouping and inference live in
  `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-timeline.ts`.
- Replies render Markdown through the shared `@caxri/markdown` block tree
  ([`components/markdown/`](../apps/desktop/src/renderer/src/components/markdown/markdown-blocks.tsx)):
  leveled headings, nested and task lists, quotes, tables with Copy table (Markdown plus HTML), and
  fenced code with a header (language, word-wrap toggle, Copy code) painted by Monaco's colorizer
  once the fence closes. A reply offers Copy message only while the pointer is over it (or focus reaches the button), after
  it finishes, followed by the time the reply began.
- Message times follow the Codex app. A centered day break (`Today 17:59`, `Yesterday 09:12`,
  `Oct 3 17:59`) heads the first user message of each day. Under a user message, a hover row shows
  its time and Copy message; the row keeps its height, so revealing it never shifts the transcript.
  Every time carries a tooltip with the full date. Formatting and day grouping live in
  `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-time.ts`.
- From the second user message, a message rail sits at the pane's left edge: one tick per user
  message, the one being read longer and brighter. Hovering a tick previews its message, and
  clicking it stops following new output and jumps there. Ticks shrink together rather than scroll
  when a long conversation would overflow the view
  (`apps/desktop/src/renderer/src/features/agent-chat/agent-chat-rail-marks.ts`).
- Cmd+F in a Chat opens a find bar at the conversation's top right, clear of the message rail and
  Jump to latest. It reuses the Terminal's `terminal.find` command: a Chat registers itself as its
  Terminal's search handler, so the same key reaches it in a pane or the Commander window. Every
  occurrence of the query in the rendered conversation is painted through the CSS Custom Highlight
  API (`::highlight(agent-chat-find)` and `agent-chat-find-active` in `styles.css`), leaving the
  Markdown DOM untouched; matching ignores case, treats the query as plain text, and never spans
  two blocks. The bar counts `i/N`; Enter and Shift+Enter step with wraparound and scroll the
  current match to a third of the view, which stops following new output. A new query starts at
  the first match on screen rather than the top of the conversation. Matches are recomputed as a
  reply streams without moving the view. A finished turn folded behind `Worked for` opens when one
  of its messages mentions a query of three or more characters, since folded content is not in the
  DOM, and folds back when a refined query stops matching. Escape closes the
  bar, clears the highlights, leaves opened turns open, and returns focus to the composer. Times in
  a message's hover row are not searched, since they are invisible until hovered. Find does not read tool output
  inside a collapsed work row, earlier messages the window has truncated, or regular expressions.
  Logic lives in `agent-chat-find.ts` and `hooks/use-agent-chat-find.ts`.
- A web link in a reply or pasted into a user message shows the site's favicon and opens a hover
  card naming the host with an Open action. For HTTPS links, the card previews the page's share
  image, title, and description. Main reads them through the `links.preview` desktop method
  (`apps/desktop/src/main/link-previews.ts`): the HTML head only, at most 256 KiB, a 5 s timeout,
  Open Graph then Twitter Card then `<title>` fallbacks, HTTPS images only, and a per-app-lifetime
  cache of 256 URLs that evicts the oldest inserted entry (a repeat hover does not refresh it; an
  outright network failure is not cached). A page that declares nothing keeps the card's link summary.
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
  Parsing and counting live in `apps/desktop/src/renderer/src/features/agent-chat/agent-chat-diff.ts`.
- A finished turn ends with what it left behind, between its final reply and Copy (or alone when
  the turn stopped before replying), so the result survives the `Worked for X` fold. The files its
  completed changes touched merge into one card: `Edited <file>`, `Created <file>`, or
  `Edited 3 files` over the turn's `+A -D`. Hovering the counts swaps them for `View changes` and
  previews every diff; View changes (or a row) discloses them in place. A file the turn created and
  deleted again is left out. Undo restores the turn's files all or nothing: each file is read and
  its reverse planned first, and if any no longer holds what the turn left (edited since, missing,
  recreated, or a diff Server Core truncated) nothing is written and a toast names the file.
  Created files go to the Trash behind its usual confirmation; edits and deletions are reversed
  through `files.write`/`files.create`, so Session path authorization applies and a file outside
  the Project cannot be undone. Pull requests and issues the turn created or edited follow as
  cards opening the page: a completed `gh pr|issue create|edit` whose output printed the URL, or
  a GitHub or Linear MCP create/update/save call. Collection lives in `agent-chat-turn-artifacts.ts`
  and `agent-chat-trackers.ts`, Undo in `agent-chat-undo.ts`. Desktop only; the phone shows the
  plain timeline.
- Review on that card opens the turn as one diff in a `Turn changes` tab beside the Chat, in the
  side pane task tabs use (`caxri-agent-turn-review://<terminal>/<turn>`). It lists the same files
  the card does, each with its Git status letter, Project-relative path, `+A -D`, and every edit
  the turn made to it in order; the projection is read from the shared `agentChat.read` cache, so
  nothing new crosses IPC. Hovering a line of code shows `+`, which opens a comment on it;
  Shift-clicking `+` on another line of the same hunk extends the range; a line in another hunk
  starts the range over there, since the hunks' line numbers need not be contiguous. Cmd+Enter or Add to Chat
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
- A sealed gateway frame carries 64 KiB, while a Chat projection may hold megabytes.
  `mobile.agentChat.read` therefore returns a window of the newest items within 48 KiB and sets
  `truncated` for the rest. Each item is shortened deterministically by
  `packages/protocol/src/mobile/mobile-agent-chat-contract.ts`: messages, reasoning, and output keep
  their tail behind a `…` marker, so streamed `appendText` deltas still continue the phone's copy;
  diffs keep their head under one budget per file change.
- The `{kind:'agentChat',terminalId}` subscription forwards each `agentChat.patch` after the
  subscribe ACK, shortened the same way. A patch that still does not fit one frame becomes a
  content-free `agentChat.changed`, and the phone re-reads. The phone folds patches with the
  shared `applyAgentChatPatch`, holds those that arrive during a read, and re-reads on any break in
  the revision chain.
- The composer shows the model and effort the next turn uses, with the same names as the Desktop
  model menu (`agentChatModelLabel` in `packages/protocol`). Tapping it opens a sheet with the
  `Model` and `Reasoning effort` lists; a choice applies on tap through
  `mobile.agentChat.configure`, which forwards `agentChat.configure` and therefore the same
  validation against `models`. A new Chat can be configured before its first message. During a
  turn the sheet says the change applies from the next turn. A Claude Code Chat that has not named
  its model yet asks for a model before it lists efforts. A provider without a model list, a
  `view` device, or a stale connection shows the model as plain text; an open sheet stays open with
  its lists disabled and the composer's reason.
- Roles: `view` reads; `reply` also sends, switches the model and effort, and retries a failed Chat; `control` also answers
  approvals and questions and stops a turn. Mutations resolve the Terminal through the device's
  granted Projects, refuse a non-Chat Terminal with `CONFLICT`, and go through Core's mutation
  admission like a Desktop request. Retry restarts only a `failed` Chat (`terminal.restart` with
  `mode: 'resume'`).
- Images. A `reply` or `control` phone attaches up to 4 images from the library, camera, or
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
  `agentChat.readImage`, so they reach exactly the images Desktop can reopen. Codex keeps no
  readable original, so its viewer enlarges the thumbnail and says the full-size image is not
  available; only an image with neither reads "This image is no longer available.". The gateway caches the last two originals for a minute so
  paging one does not re-read the transcript per chunk. The phone keeps thumbnails in memory and
  writes an opened original only to its cache directory for display.

## Images and slash commands

- **Images.** A provider with `capabilities.chatImages` (Codex and Claude Code) accepts up to 20 PNG,
  JPEG, GIF, or WebP images per message, at most 5 MB each and 20 MB together, pasted, dropped
  anywhere on the Chat, or chosen with the composer's Attach files button. 5 MB is the Anthropic
  API's per-image limit; 20 images stays under its stricter 2000 px dimension rule for requests with
  more than 20; and 20 MB keeps the worst-case payload where four full-size images already put it,
  inside the API's 32 MB request limit once base64 adds a third. Server Core enforces the same count
  and combined size. An image alone is a valid message. `agentChat.send` carries each
  image's base64 data straight to the provider (Codex `image` data-URL input, a Claude `image`
  content block) and never stores it. The projection keeps only the Renderer-made JPEG thumbnail (at
  most 48 KB, raster data URLs only), which counts against the text budget. Codex pairs it with the
  echoed user message through `clientUserMessageId`. A resumed Chat knows how many images a message
  had, but their previews were the sending Client's. For Claude Code, whose transcript keeps each
  image, the Renderer reads the original back with `agentChat.readImage` (message item id and image
  position; no provider process is needed), makes the same thumbnail, and caches only the thumbnail.
  Codex history comes from its app-server, whose item ids name no on-disk record, so a resumed Codex
  image stays a placeholder, as does an image the transcript tail no longer reaches.
- **Other files.** Attach files opens the system file picker (Chromium's file input, which is the
  native open panel, so no Main dialog method is involved). A picked or dropped file that is not an
  attachable image, and every file for a provider without image input such as Grok Build, is
  inserted at the caret as its path, relative to the Agent's directory and quoted the way a
  Terminal drop is. Every provider reads files from disk with its own tools, so a path is the one
  representation all three send paths share; no file contents are inlined.
- **Long paste.** Pasted text longer than 32 KiB (`AGENT_CHAT_LONG_PASTE_THRESHOLD`, T3 Code's
  pasted-text attachment size), or any paste the 100,000-character message limit would otherwise
  cut, never enters the input. `agentChat.saveLongPaste` writes it through the same service and
  owner-only, pruned file store as [Terminal long paste](low-cost-generation.md#terminal-long-paste),
  and the composer inserts that reference where the paste landed. Send waits while a save is in
  flight. A paste past the 16 MiB file limit is refused with the Terminal's message, and one whose
  reference would no longer fit in the message is refused with a prompt to shorten it.
- **Slash commands.** The snapshot's `commands` is the list the composer offers after a leading
  `/`. Codex lists `/compact`, which runs `thread/compact/start`; issued during a turn it waits in the
  queue.
  Claude Code reports its own list (built-in commands, skills, and custom commands) from the SDK's
  `initialize` response and `commands_changed`, minus the `terminal_slash_commands` that only make
  sense in its terminal UI; the command runs as prompt text, as in Claude Code itself.
- **Skills.** A leading `/` or `$` also lists the skills the
  [Agent Commands & Skills](agent-actions.md) picker discovers for this Terminal (`agentActions.list`,
  after the user's Settings overrides), ranked by the picker's search. Picker-only commands are
  left out because a Chat runs only what its provider reported, and a skill Claude Code already
  lists keeps its command row. Choosing a skill inserts its invocation and a space instead of
  sending: a Codex `$skill` travels as ordinary text, which Codex resolves to the skill the same way
  its own composer does.
- `agentChat.runCommand` runs a listed command with optional arguments and rejects anything the
  Chat does not list with `VALIDATION`. In the composer, Arrow keys move through matches, Tab or
  Enter chooses one, and Escape dismisses the list. A command that takes no arguments runs when
  chosen; one that does is completed so its arguments can be typed.
- **Session references.** Typing `@` at the start of a word lists other Sessions with an Agent
  conversation, searched by title. Choosing one replaces the typed `@word` with a reference to a
  condensed copy of that conversation; see
  [Citing another Session](session-conversation-context.md#citing-another-session-with-).
- Image bytes, thumbnails, and command arguments never reach logs.

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
  The meter's percentage and color measure against it: `--warning` from 50%, `--danger` from 70%.
- `cacheTtlMinutes` and `lastResponseAt`: how long the prompt cache survives an idle Chat, counted
  from the latest response. Claude Code's lifetime comes from the response's cache-write split (any
  one-hour write means 60 minutes, otherwise five-minute writes mean 5) and defaults to 60. Codex
  reports no lifetime, so it is an estimated 30 minutes.
- `cacheRewriteUsd`: the standard API price of writing the whole context into the cache again,
  from the price list bundled with the build (`apps/server/src/domains/usage/pricing.ts`, the
  same LiteLLM data the Usage page uses) at the cache-write rate the lifetime selects. A
  subscription spends allowance instead, so this is an estimate of weight, not an invoice.

While no turn runs, the composer shows these as one row in the activity bar's place, judged on a
minute clock: once the Chat has idled past the cache lifetime, a `--warning` notice says the next
message rewrites the context and what that costs; from 70% of the compaction window, a `--danger`
notice suggests `/compact`. Both can show at once, cache first.

The expired-cache notice also offers **Continue in new Chat**, the cheaper way out of a large cold
context. It opens a new Chat of the same Agent in the same Session and sends it a handoff prompt
(`agentChatHandoffPrompt`) naming the previous conversation, session ID, transcript path (from
`terminal.agentTranscript`), and working directory. The prompt has the new Chat dispatch one
subagent on a cheap model to condense the transcript before it continues, so the old context is
never loaded whole. An unsent draft travels with the prompt as the request to handle after
catching up, and leaves the old composer only once the new Chat accepted the prompt. A Chat with
no transcript on disk refuses with an error instead of opening an empty Chat.

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
  the usage meter takes the new model's `totalContextTokens`. Its reasoning efforts are not
  offered yet, so every Grok Build model lists no `efforts`.

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
untrusted`; such a Chat keeps those settings until the user picks a level. `planMode` is present
only for a provider that has plan mode.

A switch is saved on the Chat's Terminal (`terminals.chat_permission_mode`,
`terminals.chat_plan_mode`), so a restart, resume, or app relaunch starts with it. A level the Chat
only inherited from the launch settings is not saved until the user picks one, so toggling plan mode
alone leaves the Chat following the Settings autonomy switch. How it applies
mid-Chat differs per provider:

- **Codex** has no in-place request, so a level rides on the next `turn/start` as
  `approvalPolicy`, `approvalsReviewer`, and `sandboxPolicy`, which Codex keeps on the thread; a
  running turn keeps the level it started with. `thread/start` and `thread/resume` pass the saved
  level directly. Plan mode is app-server's `collaborationMode`, which names the model and effort it
  runs with: it is sent on every turn while on, and `default` is sent once to turn it off when the
  thread last ran in plan mode (as `thread/resume` reports or the last turn sent). Codex's `plan`
  item shows as an Agent message. A real-Agent E2E ignores the choice and keeps its fixed read-only
  thread.
- **Claude Code** switches in place with `Query.setPermissionMode`, so a level applies from the next
  tool call, including inside a running turn. The Chat always opens with
  `allowDangerouslySkipPermissions` so Full access can be chosen later. Level and plan mode are kept
  apart because Claude Code has one mode for both: approving `ExitPlanMode` carries a `setMode`
  update to the chosen level, so plan mode ends straight at that level and no tool call runs in a
  mode Claude Code picked; Caxri then turns plan mode off and saves that. A launch
  `--permission-mode plan` is not carried over; plan mode is only the composer's toggle.
- **Grok Build** fixes its permission at launch, so a level switch restarts the Agent on the same
  conversation (`session/load`) with the new options. A running turn would be cut short, so the
  switch fails with `CONFLICT` until it finishes.

**Project default.** "Use as Project default" saves the Chat's level and plan mode for that
provider on its Project (`projects.chat_defaults`, `project.setChatDefault`). A new Chat copies it at
creation, and so does a Terminal switched to Chat for the first time; a Chat that already has a
choice keeps it, and changing the default never touches existing Chats. Without a default, a new
Chat follows its provider's launch settings.

## Lifecycle signals

A Chat begins its own launch generation with the Agent coordinator and synthesizes
`sessionIdentified`, `turnStarted`, `turnFinished`, `turnFailed`, `attentionRequested`, and
`attentionResolved` from protocol events. They take the same provenance path as authenticated
hook signals, but they do not depend on the provider's hooks setting. The coordinator skips
working-directory session discovery for an unbound Chat so it cannot claim an unrelated PTY
conversation.

## Observability

`agent_chat.process_started` (closed outcome `ready`, `failed`, or `abandoned` with its reason,
resume mode, duration),
`agent_chat.process_exited` (closed end reason with lifetime aggregates of turns, server
requests, rejected requests, and dropped frames), `agent_chat.turn_finished` (status, duration),
`agent_chat.protocol_rejected` (closed reason, protocol method name), and
`terminal.surface_switched` (closed outcome, both surfaces, duration), `agent_chat.queue_changed`
(closed reason and queue depth), `agent_chat.delivery_checked` (request method and closed outcome
`delivered` or `unknown` after a turn request timed out), `agent_chat.task_finished` (task kind, final status,
background flag, duration), and `agent_chat.rewound` (closed outcome `rewound`, `refused`, or
`failed`, provider, whether files were reverted, turns removed, duration), and `agent_chat.forked`
(closed outcome `forked`, `refused`, or `failed`, the error code when it did not fork, provider,
turns kept, duration). None of them carries
message text, command output, provider stderr, or protocol bodies.

## Testing

`apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-app-server.ts` and
`fake-claude-cli.ts`, and `fake-grok-acp.ts` are deterministic stand-ins for each provider, selected by keywords in the
user's message (approval, file-change approval, edit, oversized diff, question, plan approval,
table, slow stream, subagent, background shell, failure, crash). The Claude fake speaks the stream-json control protocol the
SDK drives and writes a real transcript, so resume is exercised end to end. Both answer a message
with images by counting them and implement compaction, so the E2E covers paste, file pick, and the
slash list for each provider. The Grok fake persists its frames so `session/load` replays them,
and takes no images. All three implement their provider's rewind (Codex `thread/revert`, the
Claude transcript chain with `--resume-session-at` and `rewind_files`, Grok `_x.ai/rewind/*`) and
log each call to a JSON-lines file in their state directory, so `service-rewind.integration.test.ts`
checks the request and the history a later resume reads. The Codex and Grok fakes also fork
(`thread/fork`, `_x.ai/session/fork`), and Claude forks through the SDK over the fake's real
transcript, so `service-fork.integration.test.ts` resumes each fork and reads its history. Unit, integration, and fake-mode E2E tests drive them; no test launches the
real CLI or calls a model.

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

## Not yet supported

Claude Code's agent picker (its `initialize` response already lists the agents). Grok Build's
plan mode, reasoning effort picker, and images (its ACP agent advertises `image: false`). Grok Build stays out
of the real-Agent smoke. On mobile, a
Chat shows no plan or context usage yet, cannot run slash commands, does not show background tasks or the
follow-up queue, cannot edit or fork from an earlier message, older history beyond the window stays on
the computer, and switching surface is Desktop-only.

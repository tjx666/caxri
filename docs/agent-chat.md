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
`terminal.switchSurface` (`apps/server/src/domains/terminal-surface-switch.ts`). The Terminal row,
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
`grok agent --no-leader stdio`), spawned by Server Core with the same
allowlisted environment as other Agent launches and no lifecycle-hook environment (the Chat
synthesizes its own lifecycle signals, so hooks would double-report).

- **Lazy start.** The provider starts on the first `agentChat.read` or `agentChat.send`. Server
  Core restart therefore never relaunches idle Chats, and boot-time Terminal restore skips them.
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
- `Bash` is a command row, `Edit`/`MultiEdit`/`Write`/`NotebookEdit` a file change whose diff is
  replaced by Claude Code's `structuredPatch` when the result arrives, `TodoWrite` the plan, and
  every other tool a generic tool row. Subagent frames (`parent_tool_use_id`, with
  `forwardSubagentText`) go to the subagent's own task projection, never the parent timeline; see
  [Background work](#background-work).
- Usage is the latest model request's input plus cache plus output tokens; the context window
  comes from the result's per-model usage.

## Grok Build mapping

`grok-chat-session.ts` speaks ACP and `grok-items.ts` holds the pure mapping:

- A turn is one `session/prompt`, named by the `promptId` Caxri sends in its `_meta`; the prompt's
  result carries the stop reason (`end_turn`, `cancelled`, `max_tokens`, `refusal`) and the
  conversation's token count. Grok Build does not echo the prompt, so it is recorded locally. A
  message sent mid-turn goes to the running turn through `_x.ai/interject`.
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
  `perTaskStopAffordance` keeps background tasks alive across an interrupt, and `stopTask` maps to
  the SDK's `stop_task`. History is rebuilt from
  `<session>/subagents/agent-<id>.meta.json` (matched by `toolUseId`) and its `.jsonl`.
- **Codex.** A subagent is a child thread; its task id is the child thread id and its row is the
  `collabAgentToolCall` (or `subAgentActivity`) item. App-server sends no `thread/started` for a
  spawned child, so notifications from an unknown thread are held briefly (8 threads, 500 each) until
  a spawn item names it. Stopping interrupts the child's turn; history comes from `thread/read`. A
  `commandExecution` with a `processId` still running when its turn ends becomes a shell task;
  Caxri initializes with `experimentalApi: true` so `thread/backgroundTerminals/terminate` can stop
  it. Codex stops streaming a command after 10,000 deltas, which sets `isOutputCapped`.
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
`turn/steer`, Claude Code `priority: 'next'`). A slash command issued during a turn is queued.
User messages record how they arrived (`delivery: 'queued' | 'steered'`), in memory only.

- The snapshot's `queue` lists each entry's text, image count, and command; image data stays on
  Server Core. At most 20 entries and 256 KiB of text.
- `agentChat.interrupt` pauses a non-empty queue (`queuePaused`) so stopping a turn never fires the
  next message by surprise; `agentChat.resumeQueue` continues it. `agentChat.removeQueued` drops an
  entry and `agentChat.sendQueuedNow` sends one ahead of the rest (steering a running turn; a
  command cannot steer). A failed dispatch puts the entry back and pauses the queue.
- The queue survives a restart of the Chat and goes out once the new process is ready; it is never
  persisted across Server Core restarts.
- In the composer, Enter queues during a turn and Cmd+Enter steers. Queued entries form one list
  above the composer, each with Edit (back into the composer), Delete, and Steer or Send now; a
  paused queue says so in the list header with Resume. Phones do not see the queue, so
  a message sent from a phone during a turn steers it, as before.
- Compaction (Codex `contextCompaction`, Claude Code `status: 'compacting'`) sets the snapshot's
  `operation` to `compacting` and raises `compactionStarted`; input sent meanwhile is queued. The
  `/compact` user bubble is hidden because the compaction notice already represents it.

## Approvals and questions

Claude Code asks through the SDK's `canUseTool` callback, keyed by the tool use id. `Bash` is a
`command` request, file tools a `fileChange` request linked to their item, `AskUserQuestion` a
`question` (answers are returned keyed by question text), and any other tool the generic `tool`
request (`Allow WebFetch?` with its URL or arguments). "Accept for this Chat" is offered only when
Claude Code suggests a session rule and applies those suggestions; decline denies the tool and
marks its row declined.

Grok Build asks through `session/request_permission`, keyed by the tool call id; its permission
options (`allow_once`, `allow_always`, `reject_once`, `reject_always`) set the offered decisions,
and Skip or a decision with no matching option answers `cancelled`. Caxri turns off
`_x.ai/ask_user_question` when it opens the session, so Grok Build never asks a question the Chat
cannot render.

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
  history never hides them. The timeline follows new output until the user scrolls up; Jump to
  latest returns to the end.
- The composer keeps an unsent draft per Chat across tab switches, clears only the text that was
  actually sent, and treats Escape as Stop while a turn runs. Its footer shows the model and the
  remaining context window. Activating a Chat's tab puts the cursor in the composer, as activating
  a Terminal tab focuses its grid, under the same rules: not behind a modal, not out of another
  text field, and not when arrow-key tab navigation activated it, which keeps focus on the tab.
  A status tab on top of the composer says whether the Chat is starting, working, or waiting on an
  answer; a working turn shows one verb chosen per turn from its id, its elapsed time, and `Esc to
stop`. Only the label is the polite live region, so the ticking time is never announced.
- Work renders as one-line rows (`Ran git status`, `Read <file>`, `Edited <file> +2 more`),
  each with the tool kind's glyph from the provider tool table shared with mobile
  (`packages/protocol/src/agent/agent-tool-presentation.ts`). Codex's login-shell wrapper
  (`/bin/zsh -lc "..."`) is unwrapped so a row shows the script that ran. Consecutive work collapses
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
  once the fence closes. A reply offers Copy message on hover after it finishes.
- While a reply streams, `repairStreamingMarkdown` completes the last block's unfinished emphasis,
  inline code, and links so raw syntax never flashes, and blocks are memoized by value so a delta
  re-renders only the block it changed.
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
- Roles: `view` reads; `reply` also sends and retries a failed Chat; `control` also answers
  approvals and questions and stops a turn. Mutations resolve the Terminal through the device's
  granted Projects, refuse a non-Chat Terminal with `CONFLICT`, and go through Core's mutation
  admission like a Desktop request. Retry restarts only a `failed` Chat (`terminal.restart` with
  `mode: 'resume'`).

## Images and slash commands

- **Images.** A provider with `capabilities.chatImages` (Codex and Claude Code) accepts up to 4
  PNG, JPEG, GIF, or WebP images of at most 5 MB each per message, pasted, dropped, or picked with
  Attach images. An image alone is a valid message. `agentChat.send` carries each image's base64
  data straight to the provider (Codex `image` data-URL input, a Claude `image` content block) and
  never stores it. The projection keeps only the Renderer-made JPEG thumbnail (at most 48 KB, raster
  data URLs only), which counts against the text budget. Codex pairs it with the echoed user message
  through `clientUserMessageId`. A resumed Chat knows how many images a message had, but their
  previews were the sending Client's, so it shows placeholders.
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
- Image bytes, thumbnails, and command arguments never reach logs.

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
`agent_chat.protocol_rejected` (closed reason, protocol method name), and
`terminal.surface_switched` (closed outcome, both surfaces, duration), `agent_chat.queue_changed`
(closed reason and queue depth), and `agent_chat.task_finished` (task kind, final status,
background flag, duration). None of them carries
message text, command output, provider stderr, or protocol bodies.

## Testing

`apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-app-server.ts` and
`fake-claude-cli.ts`, and `fake-grok-acp.ts` are deterministic stand-ins for each provider, selected by keywords in the
user's message (approval, file-change approval, edit, oversized diff, question, plan approval,
table, slow stream, subagent, background shell, failure, crash). The Claude fake speaks the stream-json control protocol the
SDK drives and writes a real transcript, so resume is exercised end to end. Both answer a message
with images by counting them and implement compaction, so the E2E covers paste, file pick, and the
slash list for each provider. The Grok fake persists its frames so `session/load` replays them,
and takes no images. Unit, integration, and fake-mode E2E tests drive them; no test launches the
real CLI or calls a model.

`bun run test:e2e:real-agent` is the manual, never-CI smoke against the real CLI (see the `e2e-testing` skill). Its
Chat case runs under a real-Agent policy authorized for the Chat surface only: that run cannot open a PTY or Shell
Terminal, and the thread is pinned to a read-only sandbox with no approvals, ignoring the user's Codex launch
settings. It sends two short natural prompts, relaunches Caxri between them, and asserts only content-free signals:
Chat status, turn statuses, item counts by type, an unchanged `agentSessionId`, and the `agent_chat.process_started`
modes (`started`, then `resumed`) and `agent_chat.turn_finished` statuses from the Server Core log. It never reads,
logs, or captures reply text. The PTY smoke's policy, in turn, still refuses to start a Chat.

## Not yet supported

Claude Code's model and agent pickers (its `initialize` response already lists both). Grok Build's
model picker, images (its ACP agent advertises `image: false`), and questions
(`_x.ai/ask_user_question`, turned off for now). Grok Build stays out of the real-Agent smoke. On mobile, a
Chat shows no plan, model, or context usage yet, shows an image as its count (`[1 image]`) instead of
a thumbnail, cannot attach images or run slash commands, does not show background tasks or the
follow-up queue, older history beyond the window stays on
the computer, and switching surface is Desktop-only.

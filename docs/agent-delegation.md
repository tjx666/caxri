---
kind: living
status: current
---

# Visible Agent delegation

Visible delegation runs a task in a managed Claude, Codex or Grok Terminal (a Claude or Codex child opens as an
Agent Chat while Open Agents in Chat is on; see [Agent Chat children](#agent-chat-children)), in a sibling pane of the caller's
Session or in a new Session the caller creates for it (see
[Start work in a new Session](#start-work-in-a-new-session)). Wide caller panes split right; narrow or
tall panes split down. The existing active pane
and tab remain selected. The child uses the caller's working directory and remains available for
inspection after its answer is collected.

This implements provider delegation and continuation in
[issue #686](https://github.com/tjx666/caxri/issues/686). It does not yet replace dianjiang:
Standalone directory authorization and external caller identity are implemented below; native
provider validation and the complete migration checklist remain open in that umbrella issue.
Real Codex caller transport permissions are a separate validation boundary; target support does not
claim that every Codex sandbox can connect to a Caxri Server socket.

## Commands and authority

The CLI accepts task text from a file, so the task body never appears in its process arguments:

```sh
caxri agent delegate create --project <project-id> --session <session-id> \
  --provider claude --prompt-file ./task.md --request-id <stable-request-id> --json
caxri agent delegate status <delegation-id> --json
caxri agent delegate wait <delegation-id> [<delegation-id>...] --timeout 30000 --json
caxri agent delegate result <delegation-id> --json
caxri agent delegate stop <delegation-id> --json
caxri agent delegate list [--active] [--limit <count>] --json
caxri agent delegate create --project <project-id> --session <session-id> \
  --provider claude --prompt-file ./next-task.md --follow-up <delegation-id> --json
caxri agent delegate create --project <project-id> --session <session-id> \
  --provider claude --prompt-file ./next-task.md --resume <delegation-id> --json
```

Human mutations additionally require an explicit `--profile <path>` and confirmation (`--yes`
for unattended use). Every managed Agent Endpoint, in a Terminal or an Agent Chat, holds
`agents.delegate`; it does not provide dispatch, general Agent control, or human Terminal steer.
Server Core derives the caller Terminal from its authenticated Endpoint; a caller cannot supply a
different principal or Terminal. An Agent may start work in its own Session and in Sessions it
created, and may read, wait on, follow up, or stop only its own delegations; `list` returns them
newest first so an Agent that lost its context can recover their IDs. The authenticated human owner
can inspect tasks in the selected profile.

## Start work in a new Session

Creating and talking to another Session is ordinary Agent work, not an Agent Commander privilege.
Any managed Agent can hand a task to a new Agent in its own visible Session, in any Project the user
added, and the user can open that Session from the sidebar at any time:

```sh
caxri project list --json
caxri project add ../other-repo --json
caxri agent delegate create --project <project-id> --new-session --title "Fix login retry" \
  --provider codex --prompt-file ./task.md --request-id <stable-request-id> --json
```

- An Agent's `project list` and `session list` cover every top-level Project the user added, without
  root paths. `project add <path>` registers a folder the user has not opened yet, or returns the
  Project that already owns it; it shows a hidden Project again, and adopts an auto-registered
  worktree Project as a top-level one.
- `--new-session --title` creates a plain Session, named manually, without moving the Workbench
  selection, right before its Agent Terminal, so the Session never sits empty. A retry with the same
  request ID reuses it; a request refused before its task was recorded removes it again (metadata
  only).
- Admission for new work outside the caller's own Session requires a visible top-level Project, an
  unarchived Session, and either this request's new Session or an earlier delegation by the same
  caller Terminal in it. A user's other Sessions are refused, because a task there would fill its
  pane. Reading a task the caller owns is not limited by archiving or hiding.
- The Agent Commander uses the same flag, and additionally records the Session as its own for its
  board and archive commands; see [Agent Commander](agent-commander.md).
- The new Session records the caller's Session as its creator (`createdBySessionId`), after Orca's
  worktree lineage, where a workspace an agent creates remembers its parent workspace. The Session
  menu adds "Go to Creating Session" while the creating Session is open; an archived creator or the
  Agent Commander's hidden Session offers no entry, because navigating there must not silently
  restore it. The column has no foreign key, so deleting the creating Session or its
  Project clears it in the same transaction
  (`apps/server/src/domains/db/session-creator.ts`).
- The creating Agent can keep the sidebar tidy without the Commander's board:
  `caxri agent session rename <session-id> --title <title>`, `agent session archive <session-id>`,
  and `agent session unarchive <session-id>`. Any Agent in the creating Session may manage it,
  because the Session, not one Terminal, created it. Every other Session, including the caller's own
  and the user's, returns `NOT_FOUND`. The Agent Commander manages only Sessions it still owns, so
  Take Back revokes this as well (`apps/server/src/domains/parking-handlers.ts`).
- Delegation admission also accepts an earlier task's Session created by any Agent in the caller's
  Session, so a sibling Terminal can send it the next task.
- `--handoff` (only with `--new-session`) marks the task as the caller's Session handing its work
  on: the user is done with that Session. It is stored in the delegation record's input (no schema
  change), and the new Session's first message then reads "Continued from" the caller's Session
  instead of "Delegated by". The Agent Chat composer's `/new-session [next task]` asks the Chat's
  Agent for exactly this; see [Hand off with /new-session](#hand-off-with-new-session).

### Hand off with /new-session

`/new-session` is a Caxri command every Chat composer menu offers, ahead of the provider's commands,
whatever the provider. Caxri runs it rather than the provider: the composer sends an ordinary message
(`agentChatSessionHandoffText` in `packages/protocol/src/agent/agent-chat-commands.ts`) telling the
Chat's Agent to write a self-contained brief from the conversation, run
`agent delegate create --new-session --handoff` with the Chat's own Project and provider already
filled in, report the new Session, and stop without following the task. The Agent writes the brief
because only it holds the conversation; the next Agent cannot read it.

- **The asking Session.** Every reading of a sent message as the user's words
  (`parseAgentChatPathReferences`) returns the hand-off as the `/new-session <note>` the user typed,
  so Copy, Edit from here, prompt history, queue rows, and the phone never show the instructions.
  Desktop draws the message as a card: a `New Session` chip with the note, and once the Agent created
  the Session a "Continued in" link to it. The delegation does not record which message asked for
  it, so the link names the first Session the asking Session created at or after the message
  (`agent-chat-session-handoff-target.ts`).
- **The new Session.** Its first message is the delegated pointer, drawn as the "Continued from"
  card described under [Agent Chat children](#agent-chat-children) ("How the pointer reads") with the same glyph, so the two
  ends read as one move. The sidebar's "Created by" row points back as for any created Session.
- Caxri neither archives the asking Session nor switches to the new one: the user opens it from the
  link or the sidebar when ready.
- **From an issue card.** An issue card in the Chat (one the turn created or edited) ends with a
  "Start ENG-12 in a new Session" button that sends `/new-session Work on <reference>: <url>` from
  that Chat in one click, without touching the user's draft (`agent-chat-issue-handoff.ts`). It is
  the same hand-off, queued while a turn runs; the URL lets the Agent read the issue itself.

An Agent learns this without the `caxri-cli` skill installed. Caxri adds one short pointer to the
context of every ordinary Claude and Codex Agent, once per launch: it says the Agent runs inside
Caxri and, when the user asks to start or hand off work in another Session or Project, tells it to
read `"$CAXRI_CLI" skills get caxri-cli --full` and follow this flow
(`apps/server/src/domains/agents/session-discovery.ts`). A Terminal Agent receives it as
`additionalContext` from its first `UserPromptSubmit` hook, so it needs lifecycle hooks enabled. A
Claude Agent Chat appends it to Claude Code's system prompt; a Codex Agent Chat joins it after the
user's own `developer_instructions`, read with `config/read`, and adds nothing when Codex cannot
report them. Grok is not covered yet, and the Agent Commander keeps its own workspace instructions.

The request ID is scoped to the authenticated principal and generation. Reusing it with the same
input returns the existing task; different input conflicts. Wait timeout reports the current receipt
without interrupting, restarting, or resubmitting the task. A disconnected caller can later fetch
the saved answer using the same authorized identity. `wait` accepts up to 32 of the caller's own task
IDs and returns the first one, in argument order, that has settled or blocked. On timeout it reports
the first ID's receipt. `--timeout` accepts 100 to 300000 milliseconds here
(`MAX_DELEGATION_WAIT_TIMEOUT_MS`), above the 120000 ceiling of other CLI commands, and the CLI
validates it against that same schema constant. The wait's own `timeoutMs` is its deadline: the client arms no transport timer
of its own, which would fire first and turn that timeout result into an error. Server Core stops the
wait when its caller disconnects, and a transcript read that outlives the deadline by five seconds
fails the wait with `TIMEOUT` instead of holding it open.

## Presets and caller policy

Configure `agents.delegation` in the profile's Settings JSON. No preset or model preference is
installed automatically. The default maximum depth is two; supported values are one through eight.

```json
{
  "agents.delegation": {
    "maxDepth": 2,
    "presets": [
      {
        "name": "review",
        "provider": "claude",
        "model": "opus",
        "effort": "high",
        "useWhen": "Review a proposed implementation",
        "dontUseWhen": "The task requires editing files",
        "instructions": "Inspect the relevant evidence and report findings without editing."
      }
    ],
    "callers": {
      "claude": {
        "presets": { "review": { "provider": "codex" } }
      }
    }
  }
}
```

`agent delegate presets --project <id> --session <id>` returns the caller's available roster.
`create --preset review` selects that named entry. An owner may add `--caller claude|codex|grok` to use
that caller's bindings; a managed Agent's identity always comes from its authenticated Terminal.
Attempting to claim another provider is rejected before roster disclosure or launch.

A caller binding replaces the entire provider/model/effort tuple. Omitted model and effort use the
native provider defaults, rather than inheriting another provider's base preset or configured launch
arguments. Descriptions fall back individually. `exclude` hides and rejects named presets for that
caller; it does not prohibit explicit provider selection. Optional caller `prepend` and `append`
text accompany the roster as caller guidance. Base preset instructions remain private task content
and are never included in command arguments or roster output.

Explicit `--provider` supports `--model` and `--effort`; specifying either replaces both configured
model/effort arguments. A preset cannot be combined with these flags. Receipts expose the requested
selection, not a claim that a native provider or organization applied it unchanged.

The Server derives nesting from the caller Terminal's current launch and durable parent task.
Root tasks have depth one. Follow-up and exact resume preserve depth, launch selection and task
instructions, even if a preset is edited or removed; different explicit selection is rejected.
The current depth limit still applies to a new continuation. An idempotent retry returns its original
receipt before consulting updated settings. A human's later independent launch has no delegation
ancestry. No environment variable can supply or reset the depth.

## Correlation and persistence

Before any provider starts, Server Core saves the request, caller identity, any preallocated native session ID,
frozen launch configuration, and task fingerprint in the private profile database. Task files use
`delegations/<delegation-id>/task.md`, private directories (0700), and exclusive files (0600).
The native interactive command receives only a fixed instruction pointing at that file.

Claude Code 2.1.196 or newer within major 2 is required. Its documented `prompt_id` binds the initial
`UserPromptSubmit` to a `Stop`. Only the bound launch enables prompt/answer SHA-256 evidence.
The hook bridge forwards identifiers, digests and closed failure classifications, never task or
answer bodies. See the [Claude hook reference](https://code.claude.com/docs/en/hooks).

Claude completion requires a coordinator-applied parent Stop, the exact launch/session/turn, and a matching
answer digest in the safely resolved native transcript. Attachment ancestry and text blocks sharing
one native message identity are followed. Child completion, an old turn, terminal silence and file
EOF cannot complete a delegation. Background collection retries bounded reads because native
transcript writes can lag Stop.

Codex CLI 0.153.4 or newer within major 0 is required. Codex generates its native session ID; the
first authenticated signal from the owned launch binds it. `UserPromptSubmit` must match the private
pointer digest and supplies the exact `turn_id`. A Stop hook may continue that same turn, so it does
not make the task complete or noncancelable. Caxri reads only the matching native `task_complete`
event and its final `last_agent_message`; intermediate assistant messages and Stop digests cannot
substitute for that event. Additional Stop-hook work is part of the task. Native errors use closed
failure classifications and never copy provider diagnostic text into the result.

Codex collection starts from a bounded 4 MiB tail, retaining a fast completion written before the
first read, then reads only appended complete lines every two seconds. Unchanged files return no
content; incomplete lines remain pending. A rewritten file behind the cursor or an oversized single
record fails closed. Running tasks have no Claude-style 15-second missing-result deadline. When
Codex's persisted state proves the exact thread and turn have ended, collection gets 15 seconds to
find the final event before returning `result_missing`; a missing file cannot reserve the Terminal
forever. This state proves finality only and never substitutes for the answer event.

Grok Build requires version 1.0.24 or newer within major 1. Caxri preallocates its native session ID,
binds the authenticated `UserPromptSubmit` to the private pointer digest and exact `promptId`, and
reads only that session's durable `turn_completed` notification for the same prompt. This marker
proves finality; its `agent_result` is error detail and never supplies a successful answer. After
finding the marker incrementally, Caxri makes one bounded 4 MiB transcript read. Grok can merge
rejected Stop-hook drafts with the final answer; live `response_completed` events are not persisted.
The last authenticated Stop supplies the final answer's UTF-8 byte length and SHA-256 digest, so
Caxri selects and verifies that exact suffix from the final ACP text segment. Stop alone never
proves finality. An authenticated Stop without answer text still counts and clears the previous
answer proof; its explicit delegation marker keeps the turn available for later Stop batches.
The count of authenticated Stop receipts must match the native `hook_execution`
batches for this prompt, and the final batch must allow stopping. This rejects a stale draft digest
after failed delivery or Grok's forced Stop-continuation limit. Missing or mismatched evidence fails closed. Grok clips Stop text above 32,768
Unicode characters; such answers return `payload_overflow` because a prefix digest cannot verify
the omitted text.
The shared Grok Provider binds SessionStart identity before accepting prompt events. Child-scoped
prompt and Stop events cannot advance the parent task. Truncated Grok hook
payloads are rejected with `payload_scope_unavailable`, because their missing suffix may contain
the native-child scope.

Grok transcripts live under `GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl`.
Long working-directory names use the provider's bounded `.cwd` marker lookup; the shared safe
reader still rejects symlinked or otherwise unsafe transcript paths. Grok hooks are required for
managed launch and use the owned `hooks/caxri.json` file. The Provider renders the preallocated
identity and private-file pointer through Server-owned fields, keeping user-supplied identity and
positional overrides rejected. Native session rename is not
currently supported.

Controlled native validation with Grok 1.0.24 found a startup limitation on macOS: its read-only
sandbox rejects a symlink at `/var/run/docker.sock` while resolving container-runtime socket
denies. It exits before SessionStart or task execution with `runtime-socket deny resolution failed`
and `endpoint is a symlink`. The [provider's socket policy](https://github.com/xai-org/grok-build/blob/37949780/crates/codegen/xai-grok-sandbox/src/runtime_sockets.rs)
rejects endpoint symlinks. Caxri must not remove the system socket, disable sandboxing, or count
fixture coverage as native completion. Resolve this through a provider fix or an explicitly
authorized launch policy before claiming native Grok replacement coverage.

Install the bundled CLI instructions explicitly with
`caxri skills install caxri-cli --provider grok --local --yes`. Local installation uses
`.grok/skills/caxri-cli`; `--global` uses `GROK_HOME/skills/caxri-cli` (default `~/.grok`).
The existing managed-skill installer preserves foreign files and does not install hooks or change
provider permissions. Installing the skill does not grant an external Agent a Caxri identity;
use the explicit owner authorization below for callers outside managed Terminals.

## External callers and directory authorization

The human profile owner can authorize a caller outside Caxri without borrowing a managed Terminal
identity or giving the caller the profile-owner credential:

```sh
caxri agent delegate access create --root /absolute/project --provider codex \
  --register-project --profile /absolute/profile --yes --json
```

The root must resolve to an existing directory. `--register-project` explicitly permits creating
Project metadata if that exact canonical root is not already registered. A parent Project does not
implicitly authorize a nested root, and an automatically owned worktree Project cannot be used for
this bootstrap. The Server creates or reuses a dedicated Session for the Project and caller provider
without changing the Desktop's selection. A Project the user had hidden is shown again (the same
restore as adding its folder manually) and Server Core emits `state.changed`, so the sidebar shows where
the delegated Session runs. Project, Session and binding creation share one database
transaction. This owner CLI operation is separate from the Renderer's native folder grants.

The private response contains `clientId`, `generation`, `token`, `projectId` and `sessionId`.
Deliver it only to the intended caller through private process configuration; do not paste it into
prompts, issue comments, logs or shared artifacts. Configure that caller with:

- `CAXRI_USER_DATA_DIR`: the explicit authorized profile.
- `CAXRI_DELEGATION_CLIENT_ID`: the returned client ID.
- `CAXRI_DELEGATION_GENERATION`: the returned generation.
- `CAXRI_DELEGATION_TOKEN`: the returned token.

`caxri agent-context --json` reports the bound Project, Session and caller provider without the token.
The usual `agent delegate presets|create|status|wait|result|stop` commands then use this identity.
Pass its Project and Session IDs to `create`; any `--caller` must match its bound provider. A client
cannot read another client's answers even when both use the same dedicated Session. Reissuing access
reuses that Session but creates a distinct identity; the owner can still recover earlier results.

The credential grants only `agents.delegate`. It cannot steer arbitrary Terminals, change settings,
register another root, issue credentials or use managed-Endpoint messaging. Each dedicated Session
admits at most four active or pending tasks. The private Server registry stores only token digests,
survives restart and holds at most 128 live authorizations. Authorization lasts 12 hours by default;
`--ttl-ms` accepts one minute through seven days. Every request rechecks expiry and revocation before
returning even a cached receipt.

```sh
caxri agent delegate access list --profile /absolute/profile --json
caxri agent delegate access revoke --client CLIENT_ID --generation GENERATION \
  --profile /absolute/profile --yes --json
```

Listing omits credentials. Revocation invalidates that exact generation, including connections that
are already open; it does not terminate an already admitted task. Owner authorization can start the
packaged Server through the existing CLI startup path. A credential-bearing caller only connects to
an existing Server and never starts one implicitly. The Desktop can attach later to the same profile
and show the durable Session and child Terminal.

These roles are an application authorization boundary, not isolation between mutually untrusted
processes sharing one OS user. An external provider's sandbox must also permit the existing local
Server transport. Supplying credentials does not grant network access, and Caxri does not loosen
the caller's sandbox. A blocked loopback connection must be resolved through the caller's authorized
launch policy; it is not a reason to fall back to owner credentials or an invisible child process.

## Import dianjiang presets

The human profile owner can preview an explicitly selected JSONC configuration:

```sh
caxri agent delegate import --profile /path/to/caxri-profile --from /path/to/config.jsonc
caxri agent delegate import --profile /path/to/caxri-profile --from /path/to/config.jsonc --apply --yes
```

Preview is the default and writes nothing. Applying replaces only `agents.delegation`, preserving
other settings and their JSONC comments. The source file is never changed; source comments are not
copied. The report contains preset names, depth and whether settings would change, without private
instructions. No global configuration or skill is discovered, installed, removed or rewritten.

`agents` maps to `presets`, `harness` to `provider`, and caller `agents` to caller `presets`.
Caller model/effort tuples remain whole replacements; exclusions, descriptions, private instructions,
prepend and append retain their meaning. Import rejects unknown fields, invalid names, unsupported
provider efforts, excessive depth or lengths, duplicate presets and invalid caller references.
Inputs must be regular, non-symlink JSONC files of at most 1 MiB.

The dedicated `settings.delegation.write` capability belongs to the profile owner. Ordinary Agent
settings grants cannot change delegation instructions. The CLI rejects managed Endpoint credentials
and detected Agent or CI environments, including with `--yes`. This distinguishes owner connections
from scoped Agent connections; it is not a sandbox against another process running as the same OS
user and able to read the private profile. Clearing environment markers does not create OS isolation.

A background-child continuation belongs to the task only when the coordinator proves its exact
deferred parent turn and every subsequent prompt digest appears in order in the transcript ancestry.
An unproven new prompt fails closed with `correlation_missing`; it is not labeled human input.
The optional `correlationFailure` field identifies missing native-session, prompt-digest, turn, or
answer-digest evidence, a mismatched prompt, a changed turn, or ambiguous native completion. These
closed reasons never contain prompts, digests, or provider diagnostic text.
Core-observed input in the child Terminal marks `human_intervened`; a retired launch marks unfinished
work `interrupted`. Terminal protocol responses do not count as human input.

Saved answers include the exact source record identity, source `transcript`, byte length and
truncation flag. An answer larger than 64 KiB is rejected as `payload_overflow`, never silently
shortened. Missing bounded transcript evidence becomes `result_missing`. `StopFailure` reports
rate-limit, billing/quota, authentication, output-limit or generic provider failure; its error text
is never returned as a task answer.

Server startup marks unfinished execution `interrupted/host_reset` and never replays it automatically.
Tasks already collecting a proven Stop can finish reading their exact saved evidence. A Codex task
with a bound turn gets a bounded recovery read for a final event written before restart; missing
evidence settles as `result_missing` after 15 seconds without relaunching the Agent. Completed
answers survive restart. Deleting a Session or Project drains pending task creation and removes its
private task files before the metadata cascade. Cleanup failure retains ownership records for retry.
Project folders and user files are never removed.
At 1,024 saved task records, admission first prunes the oldest settled tasks that hold no answer
(failed, interrupted, or stopped) and removes their private task files; a task another record still
links to is kept. Completed answers and live tasks are never evicted, so admission fails with
`CAPACITY` only when nothing is prunable.

## Follow-up, stop, and recovery

`--follow-up` submits one fresh task in the existing Terminal and native conversation. It requires
the exact launch and a directly applied parent Stop with no later lifecycle activity or human input,
including an unsubmitted draft. Submission uses one bracketed paste and Enter. A bounded missing
submission confirmation fails without replaying the task. Each settled task admits only one child;
use the same request ID to recover a disconnected request. A child the Terminal Host refused before
taking any input never reached the Agent: it returns that claim, so a new follow-up or resume may
continue the parent, and it can never be continued itself. A child the Host reported undelivered
only later, or whose submission was never confirmed, keeps the claim, because a lost
acknowledgement looks the same and its prompt may still have arrived.

`stop` interrupts only the owned active task and preserves its visible Terminal. Late completion
cannot replace the interrupted receipt. `--resume` explicitly starts a fresh task on the exact saved
native conversation with the original frozen settings, replacing only the proven owned generation.
It can also recover a stopped Terminal. It never resubmits the previous task: the caller must supply
new instructions that account for uncertain prior effects. Human takeover or another launch fences
both continuation operations. Each task retains its own answer and correlation evidence.

`--continue-handover <handover-id>` is the Agent Commander's first task in a Session the user
[handed over](agent-commander.md#hand-over). Like `--resume` it relaunches the Session's existing
Agent on its exact native conversation, replacing the user's launch, but it creates the root task
of a new chain: it takes no provider or preset, refuses a human caller, refuses while the Agent is
in a turn, and fails as `launch_failed` if human input arrives during the relaunch. An Agent Chat
whose provider is still live is not relaunched: the task pointer becomes its next message through
the same launch-checked send a follow-up uses (`continueLiveChat` in
`apps/server/src/domains/agent-delegation/resume.ts`), and a message the user sent meanwhile fails
it as `human_input`. A stopped Chat resumes through dispatch like a PTY. A Chat that is starting or
being suspended (live, but with no live launch) is refused with a retryable `CONFLICT`; a Grok Build
Chat target, which an older record may still name, is refused outright because its Chat cannot
correlate a task. The hand-over is checked again, and the input epoch
the continuation is fenced against is read, in one synchronous step after the last await before the
task exists, so a message or keystroke during launch verification refuses the request instead of
being overtaken. It consumes the hand-over, so a second call is refused; later tasks continue the
chain with `--follow-up`. When dispatch refuses the resume before recording it, the hand-over is
released again so the Commander can retry.

After a Caxri restart, selecting a delegated Session restores it the way it was. While one of its
tasks is still active, only the outer Shell comes back, and that task continues only through the
explicit `--resume` above. Once every task settled (a restart itself settles an active task as
`interrupted`/`host_reset`), the Agent resumes its native conversation like any other Agent Terminal,
with the frozen launch settings of its newest task rather than the user's current defaults
(`apps/server/src/domains/terminal/restore.ts`). That restored launch is the same conversation with
nothing new typed into it, so the newest settled task adopts it (`bindEnvironment`): its owner can
still `--resume` it, which replaces the restored launch. Typing into the Terminal revokes that
durably, and a fresh restart starts a different conversation, which fences every earlier task. The authenticated profile owner can recover saved
tasks; managed caller authority remains generation-scoped, so a newly launched caller does not
inherit the previous caller's delegation ownership.

## Agent Chat children

With `session.openAgentsInChat` on, a new Claude Code or Codex child opens as an
[Agent Chat](agent-chat.md) instead of a PTY Terminal (`delegationChildLaunch` in
`apps/server/src/domains/agent-delegation/chat-child.ts`). Grok Build children, and every child
while the setting is off, keep the PTY. The setting is read when the task is admitted.

- **Launch.** The Chat starts with the task's frozen launch settings, translated like any Chat
  launch (Claude Code's read access to the task directory becomes an additional directory), and a
  Claude Code child with the preallocated session ID. The launch is handed to the Chat
  (`ChatDelegationLinks`) before the Terminal is announced, so a Client that reads the new Chat
  first starts it with that launch and dispatch joins that start. Later starts of the same Chat in
  this Server Core (restart, return from idle suspension) keep the frozen settings.
- **Pointer and correlation.** The fixed task pointer is the Chat's first message instead of an
  argument. A Claude Code or Codex Chat reports `turnStarted` with the SHA-256 of the exact message
  that opened the turn, digested when the turn starts, and Claude Code's `turnFinished` carries the
  digest of the turn's final assistant message. The launch, session, turn and prompt-digest checks
  are the same as for a PTY child, except that a turn Claude Code starts on its own after background
  work (no prompt, so no digest) continues the task when the coordinator proves it continues the
  task's deferred turn.
- **How the pointer reads.** The user never typed the pointer, so Desktop and mobile Chat draw it as
  a "Delegated by" bubble instead of a user message: the delegating Session as a link, or Agent
  Commander, and under it the task the caller wrote, clamped to six lines with Show more. The
  Server resolves both from the delegation record when it projects the message
  (`chat-delegated-task.ts` in `apps/server/src/domains/agent-chat/`), so a follow-up or resume
  shows its own task. A caller that is no Agent Terminal reads as a plain "Delegated task"; a record
  that is gone also loses the task, and its bubble keeps the raw pointer behind Show instruction.
  A `--handoff` task reads "Continued from" its Session (or "Continued from an earlier Session")
  with the hand-off glyph instead. Mobile draws the same bubble: the source, then the task clamped to
  six lines with Show more (the list owns the unfolded state, so a recycled row never keeps it), and
  the pointer behind Show instruction only when the record is gone; it does not yet read a hand-off
  as "Continued from".
- **Answer.** Collection reads the turn's final assistant message from the Chat's projection instead
  of a native transcript. A Claude Code answer must match its reported digest; a Codex task
  completes once the projection shows its turn finished, checked every two seconds. An interrupted
  or failed turn returns `provider_failed`, a turn without an assistant message or a Chat this
  Server Core no longer holds returns `result_missing`, and an answer cut at the projection's text
  bound returns `payload_overflow`. Chat children report no provider usage.
- **Follow-up, stop and takeover.** A follow-up pointer becomes one Chat message and a stop becomes a
  Chat interrupt (`apps/server/src/domains/agent-runtime/delegation-chats.ts`), admitted only while
  the task's exact Chat launch is live and not being suspended or closed. The message is checked
  against that launch again when it reaches the head of the Chat's send chain
  (`ChatDelegationLinks.sendToLaunch`) and never starts a provider, so a launch suspended meanwhile
  reports it undelivered. Every `AgentChatService.send` is human input by default and takes over
  like typing into a PTY: a Client message, a Git review send, a pull request merge notice, or a
  bug report. Only the delegation pointer, a dispatch prompt, and a Commander completion notice
  (written with `origin: 'delegation'` on a PTY) opt out. Rewinding, running a command,
  interrupting, or sending a queued message from the Chat also takes over; answering an approval
  does not.
- **Exact resume.** `--resume-from` on a child whose Chat is still live replaces that Chat's own
  launch: dispatch compares the Chat's live launch, not a PTY launch, with the one the task
  recorded. When dispatch refuses the resume before recording a receipt, the parent's chain claim
  is released, so the task can still be resumed or followed up.
- **Launch fencing and recovery.** A Chat start binds its launch the way a PTY launch environment
  does (`AgentDelegationService.bindChatLaunch`): the delegated start binds its task, and any other
  start fences the Terminal's earlier tasks. The provider process ending retires the launch. A
  Chat's projection does not survive a Server restart, so an active task of a Chat child settles
  `interrupted`/`host_reset` instead of being collected; `--resume` continues it on the bound
  conversation through the Chat restart path.

## Provider-reported usage

Completed receipts optionally include `usage` with `source: "provider"`. Claude and Codex use
`scope: "main-thread"`; Grok uses `scope: "provider-task"` because its native totals can include child Agents.
These are native input/output counters for this task; available cache, reasoning and total counters
remain separate. Counter meanings retain the provider's semantics and must not be added blindly
across cache or reasoning categories. Separate child-agent billing and estimated prices are not included.
An omitted usage object or counter means unknown, never zero.

Claude aggregates API message usage only within the exact prompt ancestry, including proven native
continuations. The authenticated final answer closes the set of API message identities; subsequent
API calls are excluded even when a system or metadata record links them to that answer. Repeated
streaming snapshots may finish an already-owned message's counters and count once. A missing
message counter omits accounting without discarding the proven answer.

Codex cumulative counters do not carry turn IDs. After an exact native completion, Caxri makes one
additional bounded transcript read to find that task's start, preceding cumulative baseline and
final counter. The task receives the delta, not the conversation total. A zero baseline requires
evidence of the first task in a fresh native session. Counter resets, interleaved turns, missing
baselines or incomplete evidence leave usage unknown. Native failure completions can retain proven
usage too. A failed optional accounting read cannot turn a completed answer into a failure.

Grok reads counters from the exact final notification and omits them when `usageIsIncomplete` is true
or any supplied counter is invalid. It preserves the provider's task scope rather than presenting
inclusive counters as parent-only accounting.

The task's revision is checked after all asynchronous evidence reads, so human takeover, stop or
relaunch invalidates accounting and answer collection together. Saved usage survives Server restart
with its answer and is not recomputed on later result reads.

## Current launch boundary

Launch settings are frozen per task. Claude supports the explicit model, effort,
permission mode, agent, name and tool-list values, plus verbose, disabled slash commands, strict MCP
configuration and the existing
configured permission-bypass flag. Caxri does not add permission bypass itself. Unknown flags,
positionals, print mode, resume/session overrides and remote/background modes fail before launch.
Codex supports explicit model, sandbox and approval-policy values, plus search, no-alt-screen, and
an already configured approval/sandbox bypass. It does not add a bypass to a read-only launch.
Its private task pointer does not add `--add-dir`, which would grant write access. Config/profile
overrides and hook-trust bypass fail closed. Startup trust/login interfaces receive no synthesized
input. A task whose Agent has not started its turn 15 seconds after launch settles by process state
alone, never by Terminal content: a launch that is gone fails as `startup_not_ready`, and a live one
becomes `blocked` with `startup_waiting`, because it is usually waiting at a first-run prompt only
the user can answer. The user's input in that state answers the prompt and is not a takeover; once
the native session starts the task returns to `awaiting_ready` with a fresh 15-second deadline for
its turn. A resumed task has a conversation already, so input there still counts as intervention.

Grok supports explicit model, reasoning effort, sandbox, permission mode and tool restrictions.
Session selectors, headless modes and unknown overrides fail before launch. An already configured
`--always-approve` or `--yolo` is preserved; Caxri never adds it.

Ordinary automated coverage uses isolated fake providers. Real-provider checks use only the guarded
debug procedure, a fixed synthetic task, and content-free evidence.

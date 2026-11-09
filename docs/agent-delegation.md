---
kind: living
status: current
---

# Visible Agent delegation

Visible delegation runs a task in a managed Claude, Codex, Grok, or Antigravity Terminal (a Claude or Codex child opens as an
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
caxri agent delegate transcript <delegation-id> [--after <cursor>] --json
caxri agent delegate ask --text <question> --json   # more under "Questions from a delegated task"
caxri agent delegate stop <delegation-id> --json
caxri agent delegate redirect <delegation-id> --text <direction> --json   # more under "Redirect a running task"
caxri agent delegate list [--active] [--limit <count>] --json
caxri agent delegate history [--query <text>] [--outcome <outcome>] [--limit <1-50>] [--after <cursor>] --json
caxri agent delegate create --project <project-id> --session <session-id> \
  --provider claude --prompt-file ./next-task.md --follow-up <delegation-id> --json
caxri agent delegate create --project <project-id> --session <session-id> \
  --provider claude --prompt-file ./next-task.md --resume <delegation-id> --json
```

Human mutations additionally require an explicit `--profile <path>` and confirmation (`--yes`
for unattended use). Every managed Agent Endpoint, in a Terminal or an Agent Chat, holds
`agents.delegate`; it does not provide dispatch, general Agent control, or human Terminal steer. A delegated Chat task alone can be steered by its delegator through `agent delegate redirect`.
Server Core derives the caller Terminal from its authenticated Endpoint; a caller cannot supply a
different principal or Terminal. An Agent may start work in its own Session and in Sessions it
created, and may read, wait on, follow up, or stop only its own delegations. A delegation belongs to
the caller Terminal plus either the exact Endpoint generation that created it or the provider
conversation that Terminal held then, so an Agent resumed in the same conversation (a Caxri restart,
an idle suspension) keeps its tasks and follows them up instead of launching a second child Agent,
while a new conversation or another provider in that Terminal does not. `list` returns them
newest first so an Agent that lost its context can recover their IDs, and `history` searches the
settled ones it created long ago ([Delegation history and cost](#delegation-history-and-cost)). The
authenticated human owner can inspect tasks in the selected profile.

## Start work in a new Session

Creating and talking to another Session is ordinary Agent work, not a Caxri Bot privilege.
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
- `--project-path <dir>` replaces `--project <id>` and `project add` with one request (only with
  `--new-session`, so a `--handoff` or `--consult` still passes it too). The CLI resolves the folder
  against its working directory; the Server adds it exactly as `project add` does, so the Project is
  visible, an existing Project is reused, a hidden one comes back, and an auto-registered worktree
  Project becomes top-level. Only a managed Agent, the owner's CLI, and the Desktop may use it: it is
  the `project.add` authority, so an external delegation client, a paired device, and Caxri Bot are
  refused with `FORBIDDEN` before anything is added. The stored task and the Session still reference
  the Project by ID and never carry the path.

  ```sh
  caxri agent delegate create --project-path ../other-repo --new-session --title "Fix login retry" \
    --provider codex --prompt-file ./task.md --request-id <stable-request-id> --json
  ```

  The request ID covers the folder too: replaying it returns the recorded task without adding
  anything, and replaying it with another folder or a Project ID is a `CONFLICT`. Two requests with
  one ID run one after the other. Everything that can be refused without a side effect (the
  caller, the title language, a forced Chat the provider cannot carry) is refused before the folder
  is added; the folder must exist (`PATH_DENIED` otherwise). A refusal after the add, such as an
  unknown preset or a failed `--worktree` branch, keeps the Project: it may already have existed or
  been opened since, and removing a Project never touches the folder. The Server logs
  `agent_delegation.project_added` with a closed outcome (`created`, `existing`, `unhidden`,
  `adopted_worktree`), the caller kind, and a duration, never the path. `project add` stays the way
  to register a folder without delegating.

- `--new-session --title` creates a plain Session, named manually, without moving the Workbench
  selection, right before its Agent Terminal, so the Session never sits empty. A retry with the same
  request ID reuses it; a request refused before its task was recorded removes it again (metadata
  only). When an Agent's own Session title is Chinese, Japanese, or Korean, the title it passes
  here or to `agent session rename` must use that script, or the request fails with `VALIDATION`;
  Agents otherwise copied their English task file's wording into the sidebar.
- Admission for new work outside the caller's own Session requires a visible top-level Project, an
  unarchived Session, and either this request's new Session or an earlier delegation by the same
  caller Terminal in it. A user's other Sessions are refused, because a task there would fill its
  pane. Reading a task the caller owns is not limited by archiving or hiding.
- Caxri Bot uses the same flag, and additionally records the Session as its own for its
  board and archive commands; see [Caxri Bot](caxri-bot.md).
- The new Session records the caller's Session as its creator (`createdBySessionId`), after Orca's
  worktree lineage, where a workspace an agent creates remembers its parent workspace. The Session
  menu adds "Go to Creating Session" while the creating Session is open; an archived creator or the
  Caxri Bot's hidden Session offers no entry, because navigating there must not silently
  restore it. The column references `sessions.id` with `ON DELETE SET NULL`, so deleting the creating
  Session or its Project clears it.
- Beside the creator, the Session records how it was started (`createdByRelation`, closed values
  `delegated`, `handoff`, `consult`, `independent`; `CHECK`-constrained). The kinds follow T3 Code's thread
  relations. `delegated` is a task the creating Session waits on. `handoff` is the creator's work
  continuing in a new Session (`--handoff`, below; the Chat `/new-session` command and continuing
  in another Agent both start it in the creator's Project, though the flag itself does not require
  that). `consult` is a question or review that is not meant to change files (`--consult`, below).
  `independent` is a separate Session the creator starts for its own task and does not wait on
  (`--independent`, below).
  Server Core computes the relation from the request flags and writes it with the creator, only for
  an Agent or Client caller that has a Session: a Caxri Bot Session records its creator without a
  relation, and an owner CLI call records neither. The column outlives the creator's deletion
  (`ON DELETE SET NULL` clears only the creator), so the read model reports the relation only while
  `createdBySessionId` is present. `session.query` and `agent.delegation.sessions` (see
  [Delegated Session feed](#delegated-session-feed)) return both. The sidebar lists a `delegated`
  Session under its creator, gives a `consult` Session no row of its own while a Session above it
  is listed, and gives `handoff` and `independent` Sessions ordinary rows ([issue #3572](https://github.com/tjx666/caxri/issues/3572); see
  [Sidebar rows](#sidebar-rows)).
- The creating Agent can keep the sidebar tidy without Caxri Bot's board:
  `caxri agent session rename <session-id> --title <title>`, `agent session archive <session-id>`,
  and `agent session unarchive <session-id>`. Any Agent in the creating Session may manage it,
  because the Session, not one Terminal, created it. Every other Session, including the caller's own
  and the user's, returns `NOT_FOUND`. Caxri Bot manages only Sessions it still owns, so
  Take Back revokes this as well (`apps/server/src/domains/parking-handlers.ts`).
- Delegation admission also accepts an earlier task's Session created by any Agent in the caller's
  Session, so a sibling Terminal can send it the next task.
- `--worktree <new-branch>` (only with `--new-session`, not for Caxri Bot) creates a linked Git worktree
  on a new branch forked from the Project checkout's HEAD, at `<project>.worktrees/<branch>` (slashes
  become dashes), and runs the Session there. The worktree is registered as the Project's worktree
  Project and bound as the Session's Workbench Root, the same result as "continue in worktree"
  (`WorkbenchRootService.prepareDelegatedWorktree`/`bindDelegatedWorktree`), so the sidebar lists the
  Session under the original Project. The worktree is made before the Session: a Git refusal (bad or
  existing branch) leaves no Session. A request refused after the worktree exists keeps it on disk;
  cleanup is outside this feature. Worktree-per-task dispatch follows Orca's `worktree create --agent`.
- `--handoff` (only with `--new-session`) marks the task as the caller's Session handing its work
  on: the user is done with that Session. It is stored in the delegation record's input (no schema
  change), and the new Session's first message then reads "Continued from" the caller's Session
  instead of "Delegated by". The Agent Chat composer's `/new-session [next task]` asks the Chat's
  Agent for exactly this; see [Hand off with /new-session](#hand-off-with-new-session).
- `--consult` (only with `--new-session`, never together with `--handoff`) marks the task as a
  question or review the caller asks another Agent, which is not meant to change files; nothing
  enforces that. It is stored in the delegation record's input like `--handoff`, and the new
  Session's relation is `consult`. Without a relation flag the relation is `delegated`.
- `--independent` (only with `--new-session`, never together with `--handoff` or `--consult`) starts
  an [independent Session](#independent-sessions). It is stored in the delegation record's input like
  `--handoff`, and the new Session's relation is `independent`.

### Independent Sessions

When the user asks an Agent to "open another Session for X", the new Session is a sibling, not a
child the Agent waits on. `agent delegate create --new-session --independent` runs the task from the
prompt file and returns a receipt like any other task, but the creator is out of the loop:

```json
{ "createdBySessionId": "<creator>", "createdByRelation": "independent" }
```

- **No notice.** A task in an `independent` Session never produces a settlement, question, or
  approval notice for the creator (`noticeCallerOf` returns the `independent` reason, logged as the
  closed `reason` of `agent_delegation.settlement_notice`).
- **No roll-up.** The Session is not a `delegated` or `consult` edge, so the creator's Delegated
  Sessions strip, delegated cost, and needs-input roll-up leave it out.
- **No question or approval routing.** A question the child asks goes to the user at once
  (escalation reason `parent_gone`), and a permission request raises its alert immediately instead
  of being held for the creator's decision, as in a Session the user started.
- **Rights kept.** The creator may still `rename` and `archive` the Session it created, and
  `wait` and `result` work if it calls them. Neither a Summary instruction nor a stored result is
  written, and the Session has no hand-back: the user owns it from the start.
- **Sidebar.** An ordinary top-level row in its own Project. In its Chat the first composer-strip
  row reads `Started from <title>` (zh-CN `由 <title> 创建`) with a `Back to <title>` link, and says
  nothing about results or takeover.
- **Choosing the flag.** The `caxri-cli` skill tells Agents to use `--independent` when the user
  asks for a separate, parallel, or sibling Session that the creator will not wait on, and the
  default only when the creator waits on and reads the result.

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
  Desktop and the phone draw the message as a card: a `New Session` chip with the note, and once the
  Agent created the Session a "Continued in" link to it. The delegation does not record which message
  asked for it, so the link names the first Session the asking Session created at or after the
  message (`agentChatSessionHandoffTarget` in `@caxri/protocol`, fed by the Session's `createdAt` and
  `createdBySessionId`, which the phone's dashboard carries). The phone lists no archived Session, so
  an archived target shows no link there. The phone's composer offers `/new-session` first in its
  command menu, and its issue cards carry the same start button as Desktop's.
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
(`packages/protocol/src/configuration/agent-session-instructions.ts`). The text is the
`agents.sessionInstructions` setting (Settings › Agents › Session instructions), whose default is
that preset: the user can rewrite it, clear it to add nothing, or reset it to the preset. The
preset is stored as `null` rather than as its text, because `settings.jsonc` holds every default
and would otherwise freeze the first preset it saw; `null` follows the installed version's preset. Each launch reads the current value,
so an edit reaches Agents started afterward. A Terminal Agent receives it as
`additionalContext` from its first `UserPromptSubmit` hook, so it needs lifecycle hooks enabled. A
Claude Agent Chat appends it to Claude Code's system prompt; a Codex Agent Chat joins it after the
user's own `developer_instructions`, read with `config/read`, and adds nothing when Codex cannot
report them. Grok is not covered yet, and Caxri Bot keeps its own workspace instructions.

Unless the setting is cleared, Caxri appends one line naming its interface language (the
`workbench.language` setting, or the system language Desktop last reported for "Follow system") and
asks the Agent to write the task file and title of every Session it creates in that language. The
task file is the new Session's first message, and Agents otherwise wrote it in English, the
language of their code and agent files, while the rest of the page spoke the user's language.

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

A settled task's `result` and `wait` answers also carry `pullRequest` (`url`, `number`, `state`,
and `changedFileCount`) when Server Core has already found a pull request for the task's Session,
the same one its sidebar row shows. It is read from that cache (`PullRequestSettlementWiring`) and
never starts a GitHub lookup, so a slow or failed lookup cannot delay or fail the answer; it is
absent until a lookup has seen one. It describes the Session, not the task: `changedFileCount`
counts every file the whole pull request changes, and is absent when GitHub reported no count.
Caxri does not attribute files to one task, so no answer reports a task-scoped file count.

### Settlement notices

A delegating Agent does not have to sit in `wait`. When a task it delegated settles, asks it a
question, or holds a permission request it may decide, Server Core writes one fixed notice to that
Agent's own Terminal, which wakes it. The notice carries task IDs, a closed phrase per event, and the commands that read each outcome. It
never carries the child Session's title, which the child Agent can rename to any text. It never carries an answer, a summary, question text, or request text: the
Agent reads those through its own authenticated commands. A request that already handed the caller a settled receipt (a refused `create --follow-up`, or its
own `stop`) is not announced again. A notice whose caller has had no live launch for 24 hours is
dropped. Several events in one 1500 ms quiet window
go out as one message of at most 32 items; the rest follow after the caller's next idle.

```json
{
  "id": "settled:<task>",
  "kind": "settled | question | approval | handback",
  "state": "pending | delivered | skipped | unknown",
  "callerTerminalId": "...",
  "callerLaunchId": "...",
  "acknowledgedAt": 1760000000000
}
```

- **Storage.** One `delegation_notices` row per event, keyed `settled:<task>`,
  `question:<question>`, `approval:<task>:<request>`, or `handback:<grant>` (see
  [Hand a taken-over Session back](#hand-a-taken-over-session-back)), so an event notifies once across
  restarts.
  Rows cascade with their task and hold identifiers and closed values only.
- **How the Chat draws it.** The notice reaches the delegating Agent as plain user text, but the
  Chat shows compact rows instead of a user bubble: one line per task with an icon, the child
  Session's title, and a status word (`completed`, `failed`, `interrupted`, `taken over`, `handed
back`, `asking a question`, `needs approval`), stacked when one message lists several; each row
  opens that Session. Before the write, Server Core records the SHA-256 digest of the exact text for
  that Terminal with its items (task ID, child Session ID, closed event) in
  `delegation_notice_deliveries`, and the Chat stamps `delegationNotice` on a user message only when
  its trimmed text matches a digest delivered to that same Terminal, so a person who types the same
  words keeps a plain bubble. Clients read the title from their own Session data by ID, never from
  the message. Unlike `delegation_notices` the delivery row does not cascade from the task, so a
  notice stays recognizable after its task is pruned (the row then reads `A Session that is no
longer available` and does not open); it cascades with the Terminal and keeps the newest 256 per
  Terminal. A refused write forgets its row. The only gap is a notice older than that cap, which
  replays as a plain message. Desktop and the phone draw the same rows with the same terms.
- **Who is notified.** Only the managed Agent launch that delegated the task (a Chat or a PTY, with a
  known Terminal and launch). Not an external delegation client, the owner's CLI, Desktop, Caxri
  Bot (which keeps its own notifier), or the creator of a `handoff` Session. A notice is pinned to
  the launch that delegated: if the caller restarted, the notice is skipped, never moved.
- **Re-read at send time.** A notice is dropped when the caller already read the outcome through
  `wait` or `result` (`acknowledgedAt`), when the question was answered or shown to the user, when
  the request was decided or shown to the user, or when a retry of the failed task is planned or
  running (its successor reports instead; cancelling the plan notices the failure after all). A
  notice is held while the caller has an open `wait` that would report the event itself, and sent
  when that wait ends.
- **Caller gate.** A Chat caller takes the notice as a non-human message, only when its projection
  is ready with no turn, queue, operation, pending request, or usage limit. A PTY caller takes a
  bracketed paste followed by Enter, only when a finished turn is proven idle and the input epoch is
  unchanged since that turn started (or the last input submitted its line), the same fence Caxri
  Bot's completion notices use. The proof is spent by each write. Held notices are re-checked on
  caller events and every 10 seconds.
- **Never twice.** A notice is claimed as `unknown` before the write. A write refused before anything
  was sent returns to `pending`; a write whose result is in doubt stays `unknown` and is never
  resent, because a duplicate wake costs more than a missed one the caller finds with `list`.
- **Idle suspension.** A caller with an active delegated task, or a pending notice, is not
  suspended for being idle, a PTY or a Chat, because suspending it ends the launch the notice is
  pinned to.
- **Logs.** `agent_delegation.settlement_notice` records `outcome` (`pending`, `deferred`,
  `delivered`, `skipped`, `unknown`, `failed`), a closed `reason` for a hold or a drop, `kind`,
  `batchSize`, `waitMs`, and `deferrals`. IDs, enums, and numbers only.

### Hand a taken-over Session back

Once the user acts in a delegated Session (types, Stop, Rewind), the Session is theirs: every task in it
carries the takeover mark, and the Agent that delegated it may not continue it
(`human_intervened`). The user can give it back with one explicit action, which lets that Agent continue
the Session once.

```json
{
  "id": "<grant>",
  "delegationId": "<newest task that ran in the Session>",
  "state": "pending | consumed | invalidated",
  "launchId": "<child launch>",
  "providerSessionId": "<native conversation>",
  "turnId": "<finished turn>",
  "inputEpoch": 12,
  "callerTerminalId": "<delegating Agent's Terminal>",
  "callerLaunchId": "<delegating Agent's launch>",
  "consumedBy": "<follow-up task, only when consumed>"
}
```

- **Who can hand back.** Owner only: `agent.delegation.handBack` (`caxri agent delegate hand-back
<task-id> --json`, or the origin row's button in the Session's Chat). An Agent grant cannot
  hand back for itself. The task ID names any task of the Session; the grant continues the newest task
  that ran, and the reply says which (`delegationId`).
- **What it does.** It sends nothing to the child. It stores one grant (`delegation_hand_backs`, at
  most one pending per task, so a repeated request answers `duplicate` with the same grant), tells
  the delegating Agent once through the notice queue (`handback:<grant>`: `The user handed Session
<id> back to you (task <id>). Continue with: caxri agent delegate create --follow-up <task>
...`; an automatic hand-back says `Caxri handed Session <id> back to you automatically after the
user left it alone ...; the user did not hand it back.` instead, so the Agent never tells the user
  they handed back what Caxri did), and marks the Session `handback_pending` in the feed. The grant
  stores its `trigger` (`user` or `auto`).
- **Guards, in order.** `not_taken_over` (the Session is not the user's); `child_busy` (a task or
  Chat turn is running, a Chat has queued input, or no finished turn is proven idle);
  `draft_active` (a Terminal Agent's prompt holds text typed and not submitted, which the pasted
  follow-up would otherwise submit with it); `child_changed` (the Terminal, launch, native
  conversation, or input epoch is gone or moved);
  `parent_gone` (the delegating Agent's Terminal or launch is gone, or its Session is archived);
  `parent_changed` (it is another launch or Endpoint generation than the one that delegated). The
  Desktop button also stays disabled while the composer holds an unsent draft: the Server never sees
  the composer, so that reason exists only in the Renderer.
- **Single use.** `create --follow-up` on a taken-over task needs a pending grant. It is measured
  against what the grant pinned, not against the task (whose input epoch predates the takeover): the
  child's launch, native conversation, input epoch, and finished idle turn, and the caller's launch.
  The grant is claimed with one conditional update before the chain claim, so two requests cannot
  both use it. A follow-up refused by the Host before any input was taken gives the grant back. A
  moved pin (`launch_replaced`, `input_epoch_moved`, `target_not_idle`, `target_lost`,
  `no_terminal`) drops the grant; a clash with another request (`parent_chained`,
  `terminal_busy`) keeps it. Without a grant the follow-up is refused as before.
- **Dropped grants.** Human input, an interrupt or a retired launch in the child's Terminal, a turn
  started by the child, or a Server restart (no pin can be proven afterwards) drops every pending
  grant, and the user hands back again. A notice for a dropped grant is skipped, never sent.
- **After use.** The follow-up is a new task in the same Terminal and conversation. The old tasks
  keep their takeover mark, history, and cost. The feed's `control` is `delegated` again until the
  user takes the Session over again.
- **Fresh creates.** While `control` is `human` or `handback_pending`, a fresh `create` into the
  Session (not `--follow-up`, `--resume`, or `--continue-handover`) from a managed Agent or an
  outside delegation client is refused with reason `session_taken_over`, because it would start a
  second Agent beside the user's conversation or move the pins of the pending grant. The owner's own
  creates and Caxri Bot are not refused.
- **Not offered.** Revoking a pending grant, a confirmation dialog, and handing back a suspended Chat
  (its launch is gone, so the pinned launch cannot be proven).
- **Automatic hand-back.** With `agents.delegation.autoHandBack` on (the default), Server Core
  hands the Session back on the user's behalf once they left it alone
  (`DelegationAutoHandBack`, after Muxy's take-over release). The wait starts when a Session whose
  `control` is `human` leaves every visible Desktop window, and only for a departure seen during
  the current Server lifetime, so a Session taken over long ago and not opened since is never
  handed back on upgrade or restart. Showing the Session again, or a phone watching its Chat,
  cancels the wait. After `AUTO_HAND_BACK_AFTER_MS` (30 minutes) it runs the owner's guards above:
  `child_busy` or `draft_active` restarts the wait, so the child must stay idle for the whole
  wait; any other refusal ends it until the user leaves the Session again. The Chat composer's
  unsent draft is Renderer-only and does not block it: the follow-up arrives as a new message and
  leaves the draft in place. The hand-back button's tooltip says the Session goes back on its own.
  Idle suspension that stops the child first (`terminal.idleSuspension.afterMinutes` below 5)
  ends the wait with `child_changed`.
- **Logs.** `agent_delegation.hand_back` records `outcome` (`granted`, `duplicate`, `consumed`,
  `invalidated`, or a refusal reason), a closed invalidation `reason` (`child_changed`,
  `parent_changed`, `restart`), a `count`, and `trigger` (`user` or `auto`) on a request's outcome.
  An automatic attempt logs only its final outcome, not each `child_busy` or `draft_active` retry.
  IDs and enums only.

### Reading a delegated Chat

`agent delegate transcript <id>` (`agent.delegation.transcript`) lets the Agent that delegated a
task read what the task's Agent Chat did so far, to check its progress without interrupting it. It
holds the same `agents.delegate` capability and ownership rule as `result`, and it never counts as
reading the answer: the task stays unread until `result` or `wait` returns it.

The page covers only the task's own conversation: from the message that started the task (shown as
a `task` row, without repeating the prompt) up to the next message anyone sent that Chat, which is
a later task or the user's first message after taking it over. Rows are typed (`agentMessage`,
`reasoning`, `command`, `fileChange`, `toolCall`, `notice`) and leave out diffs, images, and tool
arguments. A page holds at most 100 rows and 64K characters of text; a longer field is clipped to
8K characters (command output keeps its tail) and the row is marked `truncated`, and a file change
lists at most 50 paths. Pass the page's `next` as `--after` to read only newer rows, and `settled`
says the task's Agent is done. A row that can still change (a message or reasoning still being
written, marked `streaming: true`, or a step whose `status` is `running`) is never read past: the
next read returns it and every row after it again, so a reader replaces an earlier row with the
later copy of the same `id`. While a row is held open, `hasMore` is false: read again later instead
of at once. Two cases never hold, so every row stays reachable: a settled task (a background command
may keep `running` after the Agent finished), and a full page that starts at the open row, which
moves on and reports `hasMore`; read without `--after` once the task settles to see such a step's
final state.

The read uses the Chat already loaded in Server Core and never starts the Agent. An `unavailable`
answer carries a closed `reason`:

| Reason              | Meaning                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled`          | The owner turned `agents.delegation.readChildChat` off (a separate setting, `approval`, governs [parent approval](#parent-approval)). |
| `not_started`       | The task has no Agent yet.                                                                                                            |
| `not_chat`          | The task runs in a Terminal; read its answer with `result` instead.                                                                   |
| `projection_lost`   | The Chat is not loaded (closed, or Server Core restarted).                                                                            |
| `boundary_unproven` | The Chat no longer shows where the task began, so no row can be proven to belong to it.                                               |
| `cursor_invalid`    | `--after` came from another task or an earlier version of the conversation; read again without it.                                    |

A task Caxri already pruned reads as `NOT_FOUND`, like `result`.

### Questions from a delegated task

A delegated Agent that needs a decision asks the Agent that delegated it, without stopping its
work and without guessing. The exchange is flat CLI commands over five methods, all under
`agents.delegate`:

```sh
# the delegated Agent
caxri agent delegate ask --text <question> [--option <choice>...] [--request-id <id>] --json
caxri agent delegate ask-wait <question-id> [--timeout 30000] --json
caxri agent delegate ask-cancel <question-id> --json
# the delegating Agent
caxri agent delegate wait <delegation-id>... [--ignore-questions] --json
caxri agent delegate questions [<delegation-id>] --json
caxri agent delegate answer <delegation-id> <question-id> --text <answer> --json
```

A question is one `delegation_questions` row (text, options, and answer columns omitted here);
the receipt's `status` is never touched, so
a pending question does not make the task blocked:

```json
{
  "id": "q-1",
  "delegationId": "d-1",
  "sessionId": "child Session",
  "childLaunchId": "launch-7",
  "childGeneration": 2,
  "state": "open | answered | cancelled",
  "askedAt": 0,
  "escalatedAt": null,
  "escalationReason": "grace_elapsed | parent_gone | null",
  "answeredBy": "parent | user | null",
  "cancelReason": "child_cancelled | taken_over | host_reset | task_ended | null"
}
```

- **Ask.** `ask` returns `{ outcome: "asked", questionId, askedAt }` at once. A delegation holds
  one open question: a second `ask` returns `already_open` with the existing ID and changes
  nothing. A stable `--request-id` makes a retried `ask` return the original question in whatever
  state it reached. Only a delegated Agent may ask (`FORBIDDEN` otherwise), and a delegation stores
  at most 10 questions in its lifetime; the next `ask` fails with `CAPACITY`.
- **Wait for the answer.** `ask-wait` is a long poll of up to 300000 milliseconds returning
  `answered` (with `answer` and `answeredBy`), `cancelled` (with `cancelReason`), or `timeout`.
  A `timeout` means the question is still open: wait again, never ask it again. The question is
  bound to the asking child launch and generation, so `ask-wait` and `ask-cancel` re-verify it on
  every poll; an Agent restarted in the same Terminal cannot read an old answer.
- **Notice the question.** `wait` returns the outcome `question` with a `questionId` (never text)
  when a watched task has an open question. `settled` and `blocked` rank before it. It repeats on
  every wait until the question closes, so a delegating Agent that does not want to answer passes
  `--ignore-questions` and waits for settlement only. `questions` then returns the text and options
  of the open questions (at most 64), and `answer` delivers the first answer submitted; a later one
  returns `already_answered`, or `cancelled` when the question closed first, and its text is not
  delivered.
- **The user can answer.** The question shows on the delegated Session as waiting on the
  delegating Agent. It escalates to waiting on the user after a fixed 600 second grace, or at once
  when the delegating Agent's original launch is gone: the launch that created the delegation
  retired for good (including an idle suspension, because a resumed parent is a new generation
  without authority) or its Terminal was deleted. A launch that is only starting, suspending, or
  has no launch ID yet does not count. Escalation is an inline mark in the Session view, plus the
  static amber sidebar glyph of a [pending approval](#sidebar-rows) (it clears when the question is answered or
  cancelled, and shows for an external parent's immediate escalation too); it raises no
  notification or attention state, and it never answers or cancels. The
  user answers with the owner-only `agent.delegation.questionAnswer`, which an Agent credential,
  the Bot, Benchmark windows, and Mobile cannot call; `agent.delegation.questionDetail` is the
  owner-only read of the open question's text. The answer then reaches the asker as
  `answeredBy: "user"`.
- **Cancel.** An open question closes as `cancelled` when the asker withdraws it
  (`child_cancelled`), when the user types into the delegated Session (`taken_over`), when Server
  Core restarts (`host_reset`), or when the task settles, stops, or fails (`task_ended`). Deleting
  a delegation record removes its questions with it (`ON DELETE CASCADE`).
- **Bounds.** A question holds at most 2000 characters and 6 options of 120 characters each
  (trimmed, unique); an answer holds at most 4000. Longer text goes through `--file`.
- **Privacy.** Question and answer text appears only in command replies and the owner-only reads.
  Logs (`agent_delegation.question_asked|answered|cancelled|escalated`), the transient
  `agent.delegation.questionChanged` event, bootstrap, and the Delegated Session feed carry IDs,
  closed enums, counts, and durations only; the feed shows `question` as
  `{ questionId, askedAt, escalated }` plus a derived `waitingOn` (`parent` or `user`).
- **Mobile.** Mobile has no scope in this release: no Mobile role can read or answer a question
  and the event is not bridged to it. The Desktop Session view is the fallback; a question the
  user needs to answer waits there.

### Parent approval

A delegated Chat that asks permission to run a command or change files does not have to stop at the
user. The Agent that delegated the task may decide the request itself, but only when the request
falls within the permission that Agent has applied to its own Chat. Anything beyond that goes to
the user, with a reason. This is not an emulated permission level: each Agent keeps the level it was
given, and a parent never grants more than it holds
([Permission level and plan mode](agent-chat.md#permission-level-and-plan-mode)).

```sh
# the delegating Agent
caxri agent delegate wait <delegation-id>... --json   # outcome "approval", with command, cwd or paths
caxri agent delegate status <delegation-id> --json    # the same approval, plus why it is not covered
caxri agent delegate approve <delegation-id> <request-id> --revision <revision> (--accept | --decline) --json
```

The delegated task stays `blocked` (`permission_required`) while any request is pending. `wait`
returns the outcome `approval` for a covered request that is still inside its grace period, with
an `approval` object `{ requestId, kind, revision, covered, coverageReason, escalated, requestedAt }` plus
the content the parent needs to judge it: `command` and `cwd` for a command, `paths` for a file
change. An escalated or uncovered request returns plain `blocked` (the same object, `covered` or
`escalated` telling why), so a parent that declines does not spin on `approval`. `status` returns
the approval whether or not it is covered, so the parent learns the reason instead of retrying.

| Parent's applied level | Command | File change inside the Session's Project |
| ---------------------- | ------- | ---------------------------------------- |
| Full access            | Covered | Covered                                  |
| Accept edits           | Never   | Covered                                  |
| Ask, read-only, auto   | Never   | Never                                    |

For a chain of delegations the request must be covered by every Agent in the chain, and the first
Agent that is not makes the reason `ancestor_not_covering`.

- **Never covered.** A Terminal parent, a parent that is not Claude Code or Codex, an unresolved
  permission level, plan mode, a requested level that has not taken effect yet (Codex), a
  permission switch or plan exit that is not yet confirmed (Claude Code), a delegating Agent whose
  own task the user took over, any hop whose launch could not be proven, network access, any tool
  request or plan approval, a command at the 4096 character cap, a file change with no paths, more
  than 20 paths, a relative path, a path that does not exist, a path outside the Session's Project
  root, and a decision the provider does not offer. Every one of these has its own closed
  `coverageReason`. A symlink inside the Project root counts as inside, like the file explorer.
- **Grace.** A covered request is held quietly for 90 seconds: the Session's attention state, the
  sidebar, and notifications are unchanged, the row reads `Waiting for the Agent that delegated it to approve`, the Session raises no alert, and the global Chat waiting popup omits the held request (the Chat's other questions and proposed plans stay listed). After 90 seconds, or at once when the delegating
  Agent's launch is gone, or the setting is turned off, or the parent's permission is lowered, the
  request escalates: the Session raises its normal "waiting for you" alert exactly once. The held
  request appears in the popup the moment it escalates. A person typing into the root
  delegating Agent (which has no task of its own) is normal direction, not a takeover, and does not
  escalate; typing into a delegating Agent that is itself a delegated task, or into the delegated
  Chat, does. An uncovered request escalates at creation. Escalation is a mark only: nothing is approved or
  declined for the user, and a request that has alerted the user never becomes covered again.
- **One shot.** `approve` answers one request with `accept` or `decline`. It never grants a
  standing approval (`acceptAlways` and `acceptForSession` do not exist for it) and is not an
  auto-approve loop: the next request asks again. `accept` is refused with `VALIDATION` when the
  provider did not offer it.
- **Atomic and bound.** The Server rechecks the request, the delegating Agent's applied
  permission, takeover, and the Session's Project binding at answer time. `approve` requires the `revision`
  of the approval the parent read (an opaque string that changes whenever the provider rewrites the
  request under the same ID); a mismatch returns `CONFLICT` with `details.conflictReason`
  `request_changed` and nothing is sent, so the parent re-reads and judges the new text. A request
  that changed since the parent read it is a new request and is reclassified. If the user answered first, or
  the request is gone, `approve` returns `CONFLICT` ("no longer pending") and nothing is sent. If
  the request is no longer covered, `approve` returns `FORBIDDEN` with the `coverageReason`. The
  first answer wins in either direction.
- **Takeover and restart.** Typing into the delegated Session cancels the pending approval; a
  Server Core restart forgets it together with the provider request. The parent's decision does
  not take the Session over, like the user's own approval.
- **Terminal children.** A Terminal child never has an approval: it carries none in `wait`,
  `status`, the feed, or events, and its `blocked` state reads exactly as before.
- **The user can decide first.** The request card in the delegated Chat stays clickable during the
  grace. Once the request is the user's, a line above its buttons says why in a fixed sentence per
  `coverageReason`; it never repeats the command or paths.
- **After the parent decides.** The delegated Chat shows a notice (`delegationApproval`) "The
  Agent that delegated this answered the request." and the request card leaves.
- **Setting.** `agents.delegation.approval` (default `true`, owner toggle in Settings) turns the
  whole feature off: every request is then uncovered with `disabled`.
- **Privacy.** Command, working directory, and path text appears only in the `wait` and `status`
  replies to the delegating Agent. Logs (`agent_delegation.approval_*`: requested, decided, escalated, cancelled, refused), the transient `agent.delegation.approval` event, bootstrap, and the
  Delegated Session feed carry IDs, closed enums, and durations only; the feed shows `approval` as
  `{ requestId, kind, revision, covered, coverageReason, escalated, requestedAt }` plus the derived
  `waitingOn` (`parent` or `user`).
- **Mobile.** No Mobile role can call `approve` and the event is not bridged; during the grace a
  Mobile row shows no waiting, and once escalated the existing waiting state appears as usual.

## Delegation types

Four asks are built in, so an Agent needs no preset and no dispatcher of its own for them
(they replace the owner's dianjiang `second-opinion`, `review`, `operate-desktop`, and
`search-twitter` presets):

```sh
caxri agent delegate create --type review --title "Review the retry fix" --prompt-file task.md --json
```

| Type             | Runs on by default                        | New Session relation | Private instructions                                                        |
| ---------------- | ----------------------------------------- | -------------------- | --------------------------------------------------------------------------- |
| `second-opinion` | The other vendor: Codex, Claude for Codex | `consult`            | Independent evaluator: test the caller's conclusion, may disagree, no edits |
| `review`         | The other vendor: Codex, Claude for Codex | `consult`            | Report findings by severity with file and line, no edits                    |
| `computer-use`   | Codex (its bundled Computer Use plugin)   | `consult`            | Stop before irreversible actions, wait on sign-in, no secrets, screenshots  |
| `x-search`       | Grok (native real-time X search)          | `consult`            | Cite each post's URL, author, and date; say when live search is unavailable |

- **One flag.** `--type` stands in for `--new-session` and a relation flag, and takes no `--session`,
  preset, relation flag, worktree, or continuation; the CLI and the request schema
  (`isTypeForNewSession`, `isPresetExclusive`) both refuse them. `--title` names the new Session as
  usual. A follow-up (`--follow-up <id>`) keeps the type, binding, and instructions frozen on the
  task, and a fresh retry keeps the type, so its instructions and relation return even on another
  Agent.
- **Where it runs.** Without `--project` or `--project-path`, the Server runs the task in the
  Project of the caller's own Session, and in that Session's linked worktree when it works in one,
  so a review reads the changes the caller is making. An owner caller without a Session must name a
  Project.
- **Which Agent.** `agents.delegation.types.<type>` binds a type to a provider, model, and effort;
  `callers.<provider>.types.<type>` overrides it for one caller. Each step replaces the whole tuple,
  as caller preset bindings do; an unbound type runs on its default tuple
  (`defaultDelegationTypeBinding`), the model and effort dianjiang's matching preset used: a review
  on Codex `gpt-6.1-sol` at `high` (Claude `sonnet` at `xhigh` when Codex asks), a second opinion on
  Codex `gpt-6.1-sol` at `xhigh` (Claude `opus` at `high` when Codex asks), computer use on Codex
  `gpt-6.1-terra` at `medium`, and an X search on Grok `grok-4.7` at `medium`. `agent delegate presets` returns the
  effective binding per type in `types`. `--provider` (with optional `--model` and `--effort`) runs
  the type on that Agent instead, for a user who names one.
- **Relation.** Every type opens a `consult` Session (`newSessionRelation`): it takes no sidebar
  row, and the user reaches it from the asking Chat instead. Computer use changes state outside the
  repository and may wait for the user to sign in, but that needs the child's Chat in view, not a
  sidebar row. Clicking a consult's system notification therefore selects the asking Chat (its
  nearest active non-consult creator), not the consult, so the consult never flashes into the
  sidebar as the selected row (`agent-notification-runtime.ts`).
- **Side View.** Clicking a consult's timeline record, its Delegated Sessions row, or its notice
  opens the child's live Chat in the asking Chat's Side View (the Portal), as a
  `caxri-agent-delegation://<child Chat Terminal>` tab (`delegated-child-opener.ts`). The user reads
  its progress, answers it, or takes it over without leaving the parent; the tab mounts the Chat as
  the `portal` host, which drops Fork, Continue in, beside-Chat tabs, and the Delegated Sessions strip
  because each would act on the selected (parent) Session. The header's Open Session replaces Open in
  Split and selects the child's own Session. A Terminal child still opens as its own Session: one
  PTY renders in one place.
- **Instructions.** The type's fixed text (`delegation-types.ts`) opens the task file ahead of the
  caller's prompt and is frozen at admission like a preset's instructions.
- **Surfaces.** The receipt's `selection.type` labels the task: the parent strip row and the child's
  origin row show the type in the interface language (`Review`), and a timeline record reads
  `Asked Codex for a review: <title>` with an icon per type (the statuses read carries `type`).
  Settings, Agents, "Delegation types and presets" edits each type's binding: Agent (or Default,
  which removes the binding and shows the built-in default), a free-text model (blank is the
  provider default; no static model catalog exists, only a live Chat lists models), and an effort
  limited to what `isDelegationEffortSupported` accepts for that Agent and model. Changing the
  Agent clears the model and any effort the new Agent rejects. Under "By calling Agent" (collapsed
  by default, showing one summary line per override) each calling Agent can get its own binding,
  or have it removed. Every edit rewrites only the changed binding of `agents.delegation`, so
  presets and all other fields survive (`delegation-presets/types/binding.ts`).

```json
{
  "agents.delegation": {
    "types": {
      "second-opinion": { "provider": "claude", "model": "opus", "effort": "high" },
      "computer-use": { "provider": "codex", "model": "gpt-5.5", "effort": "medium" }
    },
    "callers": {
      "claude": { "types": { "second-opinion": { "provider": "codex", "effort": "xhigh" } } }
    }
  }
}
```

## Presets and caller policy

Configure `agents.delegation` in the profile's Settings JSON. No preset or model preference is
installed automatically. The default maximum depth is two; supported values are one through eight.

```json
{
  "agents.delegation": {
    "maxDepth": 2,
    "readChildChat": true,
    "approval": true,
    "autoHandBack": true,
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
`create --preset review` selects that named entry. An owner may add `--caller claude|codex|grok|antigravity` to use
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

Antigravity's `agy` waits for its authenticated `Stop` before collection and reads the answer from its
conversation database; [Antigravity](antigravity.md#delegation) owns the details.

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

### One step: `access launch`

Starting an Agent in a normal terminal (for example iTerm) does not need the manual flow below:

```sh
cd /absolute/project
caxri agent delegate access launch -- claude
```

The owner CLI issues a fresh credential for that run, starts the command with structured argv, and
revokes that exact generation when the command ends. It never prints the token; the credential reaches
only the launched process's environment.

- **Root**: `--root <dir>` if given. Otherwise the root of the top-level Project that contains the
  working directory, or the working directory itself when it is outside every Project. The folder is
  added as a Project if needed, as with `--register-project`; the confirmation says so. A worktree
  Project is refused, as with `access create`.
- **Provider**: derived only when the executable's basename is exactly `claude`, `codex`, `grok` or
  `antigravity`. Any other command (a wrapper script, a renamed binary) needs `--provider`.
- **TTL**: `--ttl-ms` as for `create`; the default is 12 hours.
- **Environment**: the four credential variables below, plus the non-secret `CAXRI_DELEGATION_PROJECT_ID`
  and `CAXRI_DELEGATION_SESSION_ID`. With these set, `agent delegate create` and `presets` use them as
  the default `--project` and `--session`. An explicit `--project`, `--project-path`, `--session` or
  `--new-session` always wins, and a default never adds a Session next to `--new-session`.
  Credential and hint variables inherited from an earlier launch or a managed Endpoint are dropped.
- **Cleanup**: the generation is revoked after a normal exit, a non-zero exit, a spawn failure,
  SIGTERM or SIGHUP, or an interrupt before the command started. The revocation is sent before the
  owner connection closes. The launcher swallows SIGINT because Ctrl-C already reaches the command
  through the terminal's process group. SIGKILL cannot be handled, so that credential lives until its
  TTL; if the revocation request itself fails, the launcher prints the exact `access revoke` command
  (client ID and generation, never the token).
- Every launch creates a fresh client, so two concurrent launches never share a credential.

A credential-less Agent no longer falls through to the profile owner. When the environment identifies
the caller as an Agent (Claude Code, Codex or Grok variables) and it carries neither a managed
Endpoint nor a delegation credential, every `agent.delegation.*` and `agent.dispatch.*` method is
refused with FORBIDDEN and a hint to use `access launch`. This covers the generic `request` entry
point. A human in a plain shell and CI keep owner authority.

### External lineage

A client does not stay inside its one Project. `agent delegate create --new-session --project <id>`
starts the task in a new Session of any Project the user can see, as a managed Agent does, and that
Session nests under the client's **anchor Session** in the sidebar as a `delegated` child (the same
creator edge, parent strip and cost roll-up as an in-Caxri delegation).

```text
Session "External Claude"            Project api   (anchor, shared)
  +- Session "Fix flow"              Project web   (created by the anchor, relation delegated)
```

- **Anchor**: one visible Session per Project and caller provider, titled `External <Provider>` (for
  example `External Claude`). Every client of that Project and provider shares it, and a fresh
  credential from `access launch` reuses it instead of adding another row. It is the nesting parent,
  not an ownership boundary.
- **Ownership**: a child Session belongs to the exact principal that created it, client ID and
  generation included. The anchor's creator edge is not proof of ownership, because many clients share
  the anchor. A client may start more work in a child Session only while a task of that exact principal
  is recorded there, or in the Session the same request just created. Once that record is pruned the
  Session is refused rather than guessed at. Reading, waiting on or stopping a task stays limited to
  the principal that started it.
- **Targets**: only a visible, non-archived, top-level Project. A hidden Project, a worktree Project,
  `--project-path` (adding a Project) and `--worktree` are refused with FORBIDDEN, so an external
  caller reaches only folders the user already added.
- **Concurrency**: at most four active or pending tasks per client, counted across all its Projects
  and Sessions, not per anchor and not per target Session.
- **Questions**: a child's `ask` addressed to an external client goes to the user at once
  (`parent_gone`) instead of waiting out the grace period, because the client has no Terminal or
  launch Caxri could watch. The question appears like any other escalated question.
- **Approvals**: an external client never approves for its child. Caxri cannot see the permission its
  own provider holds, so a permission request from the child is handed to the user, and the client's
  `approve` is refused like any caller that is not the delegating Agent. Use a managed Agent when the
  parent must approve.

### Manual credentials

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
`create --new-session` starts a task in its own Session of any visible Project; see
[External lineage](#external-lineage).

The credential grants only `agents.delegate`. It cannot steer arbitrary Terminals, change settings,
register another root, issue credentials or use managed-Endpoint messaging. Each client (client ID and
generation) may have at most four active or pending tasks in total, across every Project and Session
it delegates into. The private Server registry stores only token digests,
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

The profile owner imports an explicitly selected JSONC configuration, from Desktop or the CLI. The
file is always previewed first, and nothing is written until the import is applied.

Desktop: Settings, Agents, "Delegation presets" lists the current presets read-only (name, Agent,
model, effort, whether it carries private instructions) and offers "Import from dianjiang…". Choosing
a file opens an inline preview with a Merge or Replace choice and the counts it would add, change and
remove, plus caller-rule and depth changes. Switching the mode re-previews. Import applies the shown
preview; if settings changed since it was made, the Server rejects it as a stale preview and Desktop
shows the refreshed preview instead of writing.

```sh
caxri agent delegate import --profile /path/to/caxri-profile --from /path/to/config.jsonc
caxri agent delegate import --profile /path/to/caxri-profile --from /path/to/config.jsonc --replace --apply --yes
```

Both surfaces call `settings.delegation.import` with `sourceText` (at most 256 KiB of UTF-8), `mode`
(`merge`, the default, or `replace`), `dryRun` (default true) and an optional `expectedRevision`.

- **Merge** (default): presets are keyed by name. A preset in the file replaces the current one of
  the same name as a whole tuple (Agent, model, effort, descriptions, private instructions); a preset
  only in the current settings is kept; new presets are appended. Caller rules are replaced per
  provider. The current `maxDepth` is kept.
- **Replace**: the file's presets, caller rules and `maxDepth` become the configuration.
- In both modes `readChildChat`, `approval`, and `autoHandBack` stay as currently configured; the dianjiang format
  does not carry them. The merged result is validated again, including the 32-preset cap.

Applying rewrites the whole `agents.delegation` node: comments inside that node are lost, comments
elsewhere in `settings.jsonc` are preserved. The source file is never changed and its comments are
not copied. No global configuration or skill is discovered, installed, removed or rewritten.

`agents` maps to `presets`, `harness` to `provider`, and caller `agents` to caller `presets`.
Caller model/effort tuples remain whole replacements; exclusions, descriptions, private instructions,
prepend and append retain their meaning. Import rejects unknown fields, invalid names, unsupported
provider efforts, excessive depth or lengths, duplicate presets and invalid caller references.

A rejected file reports value-free issues only: a stage, a path, and a reason from a closed set. An
unknown field is reported at the object that holds it (`agents.0: unknown_field`), never by its name;
a record key that is not a provider id or a preset name defined in the file is shown as `*`. The
reasons are `invalid_jsonc`, `too_large`, `unknown_field`, `missing`, `wrong_type`, `invalid_value`, `too_long`,
`too_many`, `duplicate_name`, `unsupported_effort`, `unknown_preset` and `excluded_and_overridden`.
Neither the wire error message, the logs nor the report contain file text or private instructions;
Desktop and the CLI format the issues themselves. The preview result carries preset names, counts and
depth, never instructions.

A preset chip appears on delegated Session rows and on the "Delegated from" row of a delegated
Session. It shows the preset name; its provider, model and effort come from the selection frozen on
the task's receipt, so a preset edited or removed afterwards still describes what the task ran with.

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
At 1,024 saved task records, admission first prunes the oldest settled tasks that hold nothing left to read (no answer, or an answer already read
through `wait` or `result`, recorded as `collectedAt`) and removes their private task files; a task
another record still links to is kept. Unread answers and live tasks are never evicted, so admission
fails with `CAPACITY` only when nothing is prunable.

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

`redirect` steers a running Chat task in place; see [Redirect a running task](#redirect-a-running-task).

`stop` interrupts only the owned active task and preserves its visible Terminal. Late completion
cannot replace the interrupted receipt. `--resume` explicitly starts a fresh task on the exact saved
native conversation with the original frozen settings, replacing only the proven owned generation.
It can also recover a stopped Terminal. It never resubmits the previous task: the caller must supply
new instructions that account for uncertain prior effects. Human takeover or another launch fences
both continuation operations. Each task retains its own answer and correlation evidence.

`--continue-handover <handover-id>` is Caxri Bot's first task in a Session the user
[handed over](caxri-bot.md#hand-over). Like `--resume` it relaunches the Session's existing
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
released again so Caxri Bot can retry.

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

### Retry now

The owner can retry a failed delegated task from the Delegated Sessions strip or the child's origin
row ([issue #3572](https://github.com/tjx666/caxri/issues/3572)). It is owner-only: the Desktop
Renderer calls `agent.delegation.retryOptions` (`{ delegationId }`, returns the two modes with
`available` and a closed `unavailableReason`) and `agent.delegation.retry` (`{ delegationId, mode }`
with `mode` of `fresh` or `resume`, no provider). An Agent Endpoint, a delegation client, Caxri Bot,
and Benchmark are refused, and mobile role methods do not list either method. Code:
`apps/server/src/domains/agent-delegation/retry/service.ts`.

- **Eligible.** A task with `status: "failed"` whose failure is one of `rate_limited`,
  `authentication_failed`, `output_limit`, `startup_not_ready`, `provider_failed`, `launch_failed`,
  `hooks_required`, or `quota_exhausted` (`isRetryableDelegationFailure`). Any other failure
  (including `submission_unconfirmed`, whose prompt may have arrived) is `not_retryable`. A task the
  user took over, one already followed up, and one already retried are refused too.
- **Fresh.** Starts the same task in a new Session in the failed Session's Project, reusing its
  linked worktree only after proving the directory is still the one bound (`worktree_gone`
  otherwise). The provider must resolve to the failed task's provider under the current settings.
  The new record carries `retryOf`; the failed one gets `retriedAs`.
- **Resume.** Continues the failed Session through the resume path, with the saved launch settings
  and `resumeFrom` set to the failed task; its refusals read as `no_provider_session`,
  `session_changed`, `target_busy`, `target_changed`, `human_input`, or `resume_unsupported`.
- **Authority.** The retry runs as the Agent that delegated the failed task (its stored principal and
  caller Terminal), so that Agent can still `wait` on and read the new task. If that Agent is no
  longer the live generation of its Terminal, the retry is refused as `caller_gone`.
- **Claim.** `retriedAs` and the mode are saved in one synchronous step with the checks, so two
  clicks, or a click racing another window, start one task: a second request in the same mode
  shares the run, and the other mode is refused as `already_retried`. The new task's ID derives from
  the failed task's, not from the mode. A claim whose task was never stored is released when
  admission refuses the retry, and at Server startup. A claimed task cannot be followed up or
  resumed normally (`parent_chained`, shown to the user as `target_busy`).
- **Preface.** The task file of a retry opens with one fixed sentence (fresh or resume wording),
  added when the file is written. It is not part of the stored prompt, so it does not count against
  the 16 KiB task limit or repeat on a later retry.
- **Notice.** The Agent that delegated the task gets one line through the launch-pinned `write` a
  follow-up pointer uses, once per retry: `Delegated task <failed> was retried as <new>. Wait on
<new> for the result.` It is never an Agent Chat message, so it does not count as the user taking
  the Chat over, and a changed launch refuses it. Delivery is best effort and never fails the
  retry. The log carries a closed outcome and IDs only.
- **Pruning.** A failed task's `retriedAs` always protects its successor from pruning,
  and the successor protects the failed task (`retryOf`) only while it is active. Once the
  successor settles, the failed task is releasable and the chain drains oldest first.
- **Not here.** There is no attempt cap.

### Retry after the limit resets

A failed task whose receipt carries `failureResetsAt` can be retried later instead of now.
`agent.delegation.retryOptions` returns `schedule: { available, scheduledFor?, unavailableReason? }`
beside the two modes; `agent.delegation.retry` accepts `scheduleAt: 'reset'` and replies with a
discriminated `{ status: 'started', delegationId, sessionId }` or
`{ status: 'scheduled', delegationId, scheduledFor }`.
`agent.delegation.cancelScheduledRetry` (`{ delegationId }`, returns `{ cancelled }`) releases a
pending schedule. Code: `retry/schedule.ts`, `retry/schedule-time.ts`, `retry/claims.ts`.

- **A pending schedule is the retry claim plus a time.** The failed task holds `retriedAs` (the
  deterministic successor ID) and its stored `retryMode`, and its receipt adds `retryScheduledFor`
  (`failureResetsAt` plus a 60 second margin). The task itself stays `failed`. Until the successor
  is stored, any other retry request is refused as `schedule_pending`; repeating the same schedule
  returns it again. The pending failed task is protected from pruning, and the stored record rejects
  a time without a claim or an outcome beside a claim.
- **One poll, no timers.** A Watch Hub poller (15 seconds) starts after domain wiring, runs one pass
  at once, and handles each pending schedule in turn. A schedule due at startup therefore fires on
  the first pass, and a crash is repaired by the deterministic successor ID: a stored successor means
  the retry already started, so only the pending time is dropped.
- **Checks.** Firing runs the Retry now checks again with the schedule's own claim exempt. Before it
  is due, the poll also ends the schedule when the user takes the task over (`human_input`) or a Chat
  usage-limit wait is already continuing (`target_busy`). A Chat usage-limit wait that has not started
  is cancelled so only one continuation runs. A schedule more than 30 minutes late is refused as
  `missed_window`.
- **Cancel versus fire.** A fire registers itself before its first await; after that,
  `cancelScheduledRetry` returns `cancelled: false`.
- **Refusal.** The claim is released and `receipt.retryScheduleOutcome` is set in one save (closed
  enum: `caller_gone`, `target_busy`, `target_changed`, `human_input`, `worktree_gone`,
  `not_retryable`, `provider_guarded`, `launch_failed`, `missed_window`, `internal_error`), pushed as
  a receipt transition. The caller gets one best-effort fixed-text notice. Creating or cancelling a
  schedule sends no notice; a started retry sends the usual "retried" notice.

### Failure next steps

Every failure value has copy and a next step in the Desktop Renderer. The next step is a closed kind
(`DelegationNextStepKind` in `apps/desktop/src/renderer/src/features/delegation/delegation-next-step.ts`),
and a `Record` over the protocol's failure enum, so a new failure value fails the type check and
`delegation-next-step.test.ts` until it has both:

- `retry`: exactly the failures `isRetryableDelegationFailure` allows.
- `signIn` (`authentication_failed`, before `Retry`): `Sign in` runs the New Session menu's own
  sign-in (`chooseSessionSignIn`): a Shell Session in the child Session's Project with the Agent's
  sign-in command typed at its prompt, not run. Shown only where Caxri knows that command.
- `enableHooks` (`hooks_required`, before `Retry`): `Enable hooks` opens Settings on that provider's
  lifecycle hooks row (`openSettings('agent-hooks', provider)`).
- `openSession`: every other failure, including `submission_unconfirmed`. Its effects are unknown,
  so it is never retried; the user opens the Session to check.

Both the strip row and the child's origin row render these through `DelegationRetryControls`.

## Redirect a running task

`agent delegate redirect <delegation-id> (--text <text> | --prompt-file <path>) [--operation-id <id>]`
changes the direction of a task that is running now, inside the turn it is already in. It is
strict: one message steered into that exact turn of that exact launch, or a closed refusal. It is
never queued behind the turn, never starts a new turn (use `--follow-up` for new work), and never
counts as human input, so the task is not taken over. The task keeps its identity, result, cost,
and the return of its answer to the delegating Agent. Only the Agent that delegated the task (or the
owner) can redirect it, with `agents.delegate`.

Admission is checked in this fixed order, then again at the head of the Chat's send chain where the
active turn and input epoch are exact. A refusal carries a closed `reason`:

| Reason                | Meaning                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `waiting`             | The task is blocked on a question or a permission request; answer that first. |
| `human_intervened`    | A person typed in the Chat or took the task over, before or during delivery.  |
| `not_running`         | The task is not running, so there is no turn to redirect.                     |
| `not_chat`            | Only a Chat child can be redirected; a Terminal child cannot.                 |
| `launch_replaced`     | The child's Agent is no longer the launch the task started on.                |
| `turn_changed`        | The task's turn ended or changed; the message was not sent.                   |
| `not_steerable`       | The provider takes no steered input in this turn (for example Grok).          |
| `operation_reused`    | The operation ID was already used for different text.                         |
| `too_many_operations` | The task already recorded 64 redirects, the most it keeps.                    |
| `delivery_unknown`    | The provider did not confirm; the message may have arrived.                   |

- **Operation claim.** Every redirect has an operation ID (generated by the CLI unless
  `--operation-id` is passed). A claim `{operationId, digest, state}` is written to the task before
  the message is sent, where `digest` is the SHA-256 of the text, never the text. Repeating the same
  operation with the same text returns the recorded receipt and sends nothing; different text is
  `operation_reused`. A refusal that proves nothing reached the provider drops the claim, so the
  caller may retry. A claim the provider never confirmed stays `unknown`; so does one that was
  `pending` when the Server restarted. Such an operation is never sent again: read the transcript,
  then redirect again under a new operation ID only if the direction is missing.
- **Receipt.** `redirectCount` (confirmed redirects) and `redirectedAt` are added to the receipt.
- **Transcript.** A redirect that sits in the conversation appears as a `direction` row in
  `agent delegate transcript`, including one whose claim is still `pending` or `unknown`, so the
  reader of a `delivery_unknown` refusal can see whether it arrived. The slice crosses a user
  message only when it is this task's own redirect: the message envelope must name this delegation,
  a claim must exist for its operation ID, and the text digest must match. Any other user message
  or a message still held as awaiting the Agent ends the slice, as a person's input always did.
- **Chat.** Desktop and Mobile label the message "Updated direction from" the delegating Agent, as
  they label the task pointer, and only when the same claim proves it; typing the envelope by hand
  shows an ordinary message.
- **Logs.** `agent_delegation.redirected` records the outcome, the closed reason, the redirect
  count, the text length, and the duration. It never carries the text or the operation ID.
- **Providers.** Codex steers the active turn. Claude Code and Grok Build answer `not_steerable`:
  Claude Code holds a steered prompt until its next model request and may run it as the next turn
  when the current one ends first, and its echo can arrive after the turn is over, so delivery into
  the exact turn can never be confirmed. A redirect to a Claude child is refused before anything
  reaches it; use a follow-up for new work.

## Agent Chat children

With `session.openAgentsInChat` on, a new Claude Code or Codex child opens as an
[Agent Chat](agent-chat.md) instead of a PTY Terminal (`delegationChildLaunch` in
`apps/server/src/domains/agent-delegation/chat-child.ts`). Grok Build children, and every child
while the setting is off, keep the PTY. The setting is read when the task is admitted.

**Forcing the surface.** `agent delegate create --surface chat|terminal` overrides the setting for one
new task (`terminal` is the product term; the protocol value is `pty`). Choose `chat` when the parent
needs `transcript`, `approve`, or the child's questions; choose `terminal` for TUI-only work, knowing a
Terminal child has no `transcript` (`not_chat`) and no parent approval, though it can still ask
questions through the CLI. A forced `chat` works with the setting off. It is refused at admission with
`UNAVAILABLE` and reason `forced_chat_unavailable`, never downgraded, when the provider's Chat cannot
carry the task (Grok Build, Antigravity) or this Server has no Agent Chat; the check runs before the
Session or worktree of `--new-session` exists. A forced `terminal` takes the unchanged PTY branch and
still fails as `hooks_required` while the provider's hooks are off. `--surface` is a new-task option:
`--follow-up`, `--resume`, and `--continue-handover` keep the surface of the Terminal they continue and
refuse it. The surface is part of the request fingerprint, so a replay of a request ID with another
surface is a `CONFLICT`, and a fresh retry carries the forced surface to its successor. The receipt's
`surface` (`chat` or `pty`) is the surface resolved at admission, not the requested value; it is absent
for a hand-over, and a follow-up or resume repeats the task it continues. A preset does not carry a
default surface.

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
  Caxri Bot, and under it the task the caller wrote, clamped to six lines with Show more. The
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
  like typing into a PTY: a Client message, a Git review send, or a bug report. Only the delegation
  pointer, a dispatch prompt, a Caxri Bot completion notice, and a pull request merge notice
  (written with `origin: 'delegation'` on a PTY too) opt out, so a child is never taken over by the
  news that its own pull request merged. Rewinding, running a command,
  interrupting, or sending a queued message from the Chat also takes over; answering an approval
  does not, and neither does the delegating Agent's [parent approval](#parent-approval).
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

## Delegated Session feed

A `newSession` task that an Agent or Client makes from its own Session starts a Session of one of
four kinds, told apart by `createdByRelation`: a [Delegated Session](../GLOSSARY.md) (`delegated`),
a Hand-off (`handoff`), a Consult (`consult`), or an Independent Session (`independent`); the
glossary keeps them apart. A Session
Caxri Bot dispatches a task to and a Session the owner creates from the CLI record no relation, so
none of what follows applies to them: no Summary instruction, no stored result, no feed row. The
sidebar's delegated rows need each Session's state, step and result without opening it, so Server
Core exposes the following. The Renderer reads `agent.delegation.sessions` for the Sessions nested
in the sidebar; [Sidebar rows](#sidebar-rows) says what it shows
([issue #3572](https://github.com/tjx666/caxri/issues/3572)).

- **Closing summary line.** The task file of a Session whose relation is `delegated` or `consult`
  ends with this fixed instruction, appended to the body after the caller's task, on its first task
  and on every follow-up and resume alike (the pointer and its prompt digest are unchanged, because
  the digest covers the pointer, not the file): "When you finish, end your final answer with one
  line: `Summary: <one sentence, at most 200 characters, on what you did or found>`." A Hand-off, a
  Session Caxri Bot dispatched to, and a Session the owner created get neither the instruction nor a
  result row (`delegationTaskBody` in `task-body.ts` follows `shouldReportDelegationResult` in
  `feed/session-result.ts`, the one condition the stored result uses too).
  `delegationResultSummary` (`feed/result-summary.ts`) reads the answer: an authored `Summary:` line
  among the final five non-empty lines wins (`source: "authored"`); otherwise the first non-empty
  paragraph that is no heading or code fence stands in (`source: "excerpt"`). Whitespace is
  collapsed and the text is clipped to 280 characters with an ellipsis. Only emphasis that closes
  the label or wraps the whole text is dropped (`**Summary:** x`, `**Summary: x**`, `_x_`); the
  summary's own `__init__`, `*args`, `src/**` and trailing colon are kept.
- **`settledAt`.** The receipt records when a task last moved from active to settled. It is set on
  that transition and kept across later bookkeeping saves (a claimed answer, a transcript offset,
  which all move `updatedAt`). A follow-up or resume is a new task with its own receipt and its own
  `settledAt`; it never re-activates the receipt it continues. Only `AgentDelegationService.save`
  computes it (`stampedReceipt` in `receipt-timing.ts`).
- **`failureResetsAt`.** A task that failed as `quota_exhausted` or `rate_limited` carries the epoch
  milliseconds at which the provider's own limit resets, only when an authoritative source knows one
  in the future: the failing Chat turn's limit notice (`usageLimit.resetsAt`) or the provider's
  weekly usage guard, whichever is later. Otherwise the field is absent. It is looked up once, as
  the failure begins, through the narrow `limitResetsAt` service option, and never estimated.
- **Attention recovery.** A task blocked as `permission_required` returns to `running`, with the
  failure cleared, when the Agent's final attention request for the task's current turn is
  answered. The resolution arrives as `attentionResolved` (a Chat provider) or, for a Terminal Session, as
  `toolBatchFinished` (Claude Code's `PostToolBatch`, which follows a tool the user approved). Both
  are reported without a turn ID, which counts; a resolution naming another turn does not. Codex
  has no permission-resolution hook, so a Codex Terminal Session stays `blocked` until its turn ends.
  Before this, the receipt stayed `blocked` until the turn ended. A Chat child can hold several
  requests at once and stays `blocked` until the last one is resolved, whether the user or the
  delegating Agent resolved it ([Parent approval](#parent-approval)).
- **Stored result.** When a task in a Session whose creator relation is `delegated` or `consult`
  completes with an answer, its summary is written to `session_results`, one row per
  Session, replaced by each later task of that Session; a later completed task whose answer yields
  no summary deletes the row, so the feed never shows an earlier task's conclusion as the newest
  one. A `handoff` Session stores none. The row
  outlives the 1024-record pruning of `agent_delegations` and the Session's archival, so the feed
  can still show what the Session concluded; deleting the Session deletes it. It is private domain
  data: it is never part of bootstrap, journal payloads, or logs. Its neighbour
  `delegation_questions` holds the open and closed [questions](#questions-from-a-delegated-task)
  of a delegation and is removed with the delegation record, unlike `session_results`.
- **`agent.delegation.sessions`.** An owner-only read: `{ createdBySessionIds }` (1 to 64 IDs)
  returns `{ sessions }`, the Sessions those Sessions created with a relation, newest first (at most
  1000). Each entry carries `sessionId`, `createdBySessionId`, the relation, the newest task's
  `delegationId`, `provider`, `status`, `failure`, `failureResetsAt`, `retryOf`, `retriedAs` (see
  [Retry now](#retry-now); either may name a task pruned since), `retryScheduledFor` and
  `retryScheduleOutcome` (see [Retry after the limit resets](#retry-after-the-limit-resets)), `createdAt`, `settledAt`, the
  live `step` while the task is active in a Chat, and the stored `result` (`summary`, `source`, the
  `delegationId` of the task that wrote it, and its `completedAt`), and `takenOverAt` once the user
  took the Session over by first acting in it (input, Stop, or Rewind; set once; see
  [Chat surfaces](#chat-surfaces)), and `controlChanges` once the Session changed hands: each
  task's takeover (`taken_over`) and each hand-back not invalidated (`handed_back` with its
  `trigger`), oldest first, capped to the newest `MAX_DELEGATION_CONTROL_CHANGES`. A follow-up or resume the Server
  refused as `target_busy` (another task holds the Session) or as `target_not_ready` (the Session
  was not ready for it) never ran and does not stand for the Session: a task still in flight
  wins over it, and so does the newest task that ran, so a Session whose task is running never
  reads `failed` because a second follow-up was turned away. `takenOverAt` comes from the stored
  record's `humanInterventionAt`, written beside `hasHumanIntervention` on the first human input
  (input, Stop, or Rewind) of each task that lacks the mark, including a task that already
  completed and one delegated into a Terminal the user had already typed in; startup-prompt input
  does not count. It never claims an unread answer
  (`markCollected`), so looking at
  the feed cannot make a caller's answer evictable before the caller reads it. An Agent Endpoint
  principal is refused even though it can read its own delegations: other Sessions' results are not
  its to read. Caxri Bot and Benchmark windows deny it.
- **`agent.delegation.attention`.** An owner-only, non-claiming read for the parent strip:
  `{ sessionId }` returns `{ items, isPartial }`. It walks the `delegated` and `consult` edges below
  the Session (the walk `usage.delegationSummary` uses: depth 8, 1000 Sessions; a `handoff` Session is
  the user's own continuation and is neither walked nor listed), keeps depth two and deeper (direct
  children are the feed's rows), and picks each Session's representative task the way the feed does.
  The order of the steps is the contract: it folds retry chains first (`collapseRetryChains`; a failure
  with a started retry, a scheduled retry, or a pruned successor is not a to-do), then keeps the entries
  with a `delegationAttentionKind` (`approval`, `question`, `input`, or a real `failed`), then drops
  deleted and archived Sessions, ranks by kind and recency, and cuts to 64. `isPartial` is true when the
  walk hit a bound or the cut dropped an item, so a header never claims a complete count. An item is
  the feed entry without `step` and `result`, plus `branchSessionId` (the direct child it sits under);
  it carries IDs and closed values only. The held-for-the-delegating-Agent requests
  (`waitingOn: parent`) are not attention. The predicates are shared with the Renderer
  (`delegation/attention/predicates.ts` in the protocol), so the Server and the strip cannot disagree about
  what counts. Caxri Bot and Benchmark windows deny it, an Agent Endpoint principal is refused, and
  mobile role methods do not list it. The Renderer refreshes it on any delegated or unknown Session
  push and on approval and question changes, coalesced like the feed. No CLI aggregates the tree:
  `wait` covers only the caller's own tasks.
- **`agent.delegation.statuses`.** An owner-only, non-claiming read like the feed:
  `{ delegationIds }` (1 to 64 IDs) returns `{ statuses }`, one `{ delegationId, sessionId,
provider, status, failure?, failureResetsAt?, retryOf?, retriedAs?, retryScheduledFor?, retryScheduleOutcome?, settledAt? }` per task the Server still has. It
  names the exact task rather than a Session's newest, carries no summary, step, or answer text,
  and omits a pruned or unknown ID. Caxri Bot and Benchmark windows deny it, an Agent Endpoint
  principal is refused, and mobile role methods do not list it. The same invalidation as the
  feed refreshes it.
- **`callerTurnId`.** When `agent.delegation.create` runs from a caller Terminal that is an Agent
  Chat, the record stores that Chat's current turn ID (an optional field of the JSON record, so no
  SQL migration), taken through the service option `callerTurnId`. The Chat projection uses it to
  place the timeline record when the command output does not name the delegation ID (see
  [Chat surfaces](#chat-surfaces)). IDs only.
- **`agent.delegation.progress`.** A transient event `{ sessionId, delegationId, step? }` tells
  Workbench windows that an active Chat Session's step changed. The step is the Chat's current work
  as one label (the verb and subject the Chat shows, such as "Running pnpm lint"), clipped to 120
  characters; a Terminal Session has none. At most one event per second per task is emitted, the
  newest step wins, and an unchanged step emits nothing (`DelegationProgress` in `feed/progress.ts`). The
  event is not forwarded to mobile or the Caxri Bot window, is not journaled, and its step text is
  never logged. A settled task emits no closing event: the receipt change already says so.

## Sidebar rows

The primary sidebar places Sessions by `createdBySessionId` and `createdByRelation`
(`features/primary-sidebar/delegated/delegated-placement.ts`). The visual contract (indent, guide
line, glyph priority, child window) is in [DESIGN.md](../DESIGN.md); this section keeps the rules
that decide which Sessions take which place.

- **Host.** A `delegated` Session nests under the nearest Session up its creator chain that has a
  top-level row, so a chain of delegations flattens to one level. Archiving or deleting a creator
  ends the chain, and the Sessions it delegated return to their own Project groups. A pinned
  `delegated` Session keeps a flat Pinned row, and a `handoff`, an `independent`, or an ownerless
  Session keeps an ordinary row. A cycle or an over-long chain leaves the Session ordinary, so no row can vanish.
- **Takeover.** A `delegated` Session whose feed entry has `control: "human"` (the user took it over
  and has not handed it back) keeps an ordinary row in its own Project and hosts the Sessions it
  delegates. A hand-back nests it again. The feed's creator set comes from the record-only placement,
  so a taken-over Session's creator stays in the read and the row does not flap. Previous/next
  Session and selecting a Project read the same answer from the cached feed
  (`delegation-feed-cache.ts`); the command palette and share dialog list order from the records
  alone and still list it after its host.
- **Consult.** A `consult` Session takes no row while a Session above it is listed, and none once its
  creator is archived: the asking work is done and its answer was read. It shows
  nested only while it is the selected Session, and the command palette still finds it. The Activity
  view applies the same rule: it lists a consult only while the Project tree gives it a row, so a
  finished second opinion never lands in Needs attention or the attention badge.
- **Grouping.** The Session keeps its own `projectId`. Only the sidebar's grouping moves: a nested
  Session counts toward its host's group for collapsed-heading rollups and auto-collapse
  protection, and its row names its own Project.
- **Feed.** The Renderer reads `agent.delegation.sessions` for the direct creators of the nested
  Sessions, with no poll. A `state.changed` push of the delegated Session and `agent.delegation.progress`
  refresh it (`queries/invalidation-delegation-feed.ts`). Besides `control` (see Takeover), the sidebar uses the
  feed for failures: a newest task with `status: "failed"` and a failure that is a real one gives the nested
  row its failure glyph. A `failed` task whose failure is a takeover, a changed target, a
  refusal, or a stop (`human_input`, `target_changed`, `session_changed`, `caller_stopped`,
  `host_reset`, `target_busy`, `target_not_ready`, and the unreadable-result and waiting values)
  is not counted as failed anywhere, matching the row's glyph. A failed task that has a
  `retriedAs` is not failed either: the retry stands for it, and a pending scheduled retry reads
  as waiting. An interrupted,
  human-intervened, or answer-unavailable task is not a failure of the Agent and shows none.
- **Pending approval or question.** A nested Session whose request or question waits on the user
  (the feed entry carries an `approval` or a `question`, and `waitingOn: user`) keeps a static
  amber waiting glyph after the user has read the Session, because reading does not decide it. An
  escalated question qualifies (`isDelegationUserPending`), including the immediate escalation of
  an external parent's question; it still raises no notification. The glyph does not animate,
  and clears when the request or question leaves the feed (decided, answered, withdrawn, or the task ended). It is gated
  on the feed entry, never on the Session record's activity state alone: a Terminal (PTY) Session
  with a stale `waiting` state still clears once read. A request still held for the delegating
  Agent shows the muted asking glyph and no amber
  ([Parent approval](#parent-approval)). A row with this glyph is always listed, never folded.
- **Not shown.** A nested row lists no subagent rows of its own, and it is not reorderable, so its
  position follows its host. The result summary and the live step have no sidebar surface; the
  parent's [Chat strip](#chat-surfaces) shows them.

## Chat surfaces

An Agent Chat in a Workbench window shows delegated work in three places
([issue #3572](https://github.com/tjx666/caxri/issues/3572)). The visual contract is in
[DESIGN.md](../DESIGN.md); this section keeps what each surface reads and when it shows. Caxri Bot
and Benchmark windows show none of them: the host reports no Delegated Sessions capability
(`canShowDelegatedSessions` in `agent-chat-host.ts`), and the denied reads would only fail.

- **Parent strip.** The Chat of the Session that delegated has a collapsible Delegated Sessions
  section in the composer strip, one row per Session it created (`delegation/` in the Agent Chat
  feature). Its data is the `agent.delegation.sessions` feed for that one Session ID, so a progress
  or state push refreshes the rows without re-rendering the transcript. The strip also lists the deeper Sessions that need the user
  (`agent.delegation.attention`: an approval, an escalated question, a blocked prompt, or a real
  failure at depth two and deeper), sorted with the direct rows, each with a muted `via <direct
child title>` part. The header counts them in its needs-input and failed parts but keeps
  `delegated` as the direct-child count; when the Server could not read or list every deeper item
  it appends `and more`. Nothing was added to act on them: the rows are the existing rows (click
  opens the Session), with no "next item" action, and a handoff subtree is not rolled up. The section mounts only
  while the Chat is shown, so a hidden Chat does not subscribe. A hidden kept-alive Chat also
  reads no record statuses, ticks no record clock, and follows no change of its origin row's
  takeover time (`DelegationLiveContext`); showing it reads the cached values again. A completed row also shows the
  pull request found for its Session and the whole pull request's `changedFiles`
  (`<n> PR files`, labeled as the pull request's, not the delegation's). The sidebar owns the pull
  request poll; the strip starts the same poll only while the sidebar is hidden.
  A failed row whose failure can be retried carries a `Retry` action (a sibling of the row's open
  button) that opens a menu of the modes the Server allows now, read lazily on hover or focus
  (`agent.delegation.retryOptions`); an unavailable mode stays in the menu, disabled, with its
  reason. Both modes ask for confirmation first: file changes are not rolled back, and a fresh retry
  may repeat earlier side effects. Once retried, the failed row is dropped when its `retriedAs`
  equals another row's `delegationId` or `retryOf` (a fresh retry followed by a resume keeps
  working), so the strip shows one current row labeled `Attempt N`, and the header counts the
  collapsed list. Where the successor is missing from the feed the failed row stays. Several
  resume retries in a row hide the middle tasks, because the feed shows only the newest task per
  Session. A timeline record of a retried task shows a `Retried` mark.
  A usage-limit failure (`quota_exhausted`, `rate_limited`) reads its options as soon as the row
  shows and adds two direct actions next to `Retry`: `Retry with <Agent>` for each Agent in
  `switchTargets` (a fresh, immediate retry; the confirmation says the task starts over with that
  Agent's current delegation settings) and `Retry after <time>` when `schedule.available` (a trusted
  reset time exists; the confirmation names the mode it will run in, resume when available, otherwise
  fresh, and that a takeover or a changed target stops it). Any other retryable failure lists the
  switch targets in the `Retry` menu instead. The time is absolute in the interface language and
  carries the date when it is not today (`apps/desktop/src/renderer/src/features/delegation/delegation-retry-time.ts`).
  A pending schedule (`retriedAs` with `retryScheduledFor`) is waiting, not failed: the row reads
  `Retries at <time>` with a muted clock glyph and a `Cancel` action in place of the retry actions,
  the header counts it as `<n> retry waiting` and not as failed, and the timeline record shows the
  clock glyph instead of the `Retried` mark. The row stays in the collapsed list because the
  successor does not exist yet. A refusal (`retryScheduleOutcome`) is folded into the failure's
  detail line (`The scheduled retry did not run: ...`), keeps the red failure, and offers the retry
  actions again; there is no separate notice row and no dismiss action.
- **Timeline records.** A command in the Chat's own Terminal that created delegations carries
  `delegations: [{ delegationId, sessionId }]` (at most 8), stamped by Server Core from the
  delegation records of that Terminal (`CommandDelegationStamper`). The Desktop timeline draws such
  a command as `Delegated to <child title> · <child Project>` rows in place of a command row, and
  keeps them in view when the turn folds (`foldAgentChatTurn`'s optional `isAlsoKept`; mobile folds
  the command away as before). Each row's glyph is the status of that `delegationId`, read through
  `agent.delegation.statuses`, so a record keeps the outcome of the task it stands for after a
  follow-up replaced the Session's newest task. The call that created a turn's delegations is
  associated with the Chat's turn by the recorded `callerTurnId`: the projection stamps a task onto
  the command whose output names its ID (several IDs per command are allowed), and a task recorded
  for a turn but named by no command output onto that turn's last command, so a created delegation
  is never lost. A later wait or result command that names an already recorded ID is not a second
  record, and a history restore stamps again. The statuses read carries `provider` and
  `failureResetsAt` so the record words a limit failure like the strip row.
- **Approval wording.** A row that waits on a permission request reads
  `Waiting for the Agent that delegated it to approve` (muted asking glyph) while the delegating Agent holds it, and `Waiting for your approval` (amber) once it is the user's, with one fixed sentence for the closed
  `coverageReason`. The header counts escalated approvals as `<n> waiting for your approval` when
  every task that needs input is an approval, and as `<n> need input` otherwise; held ones count
  as `asking`, which is not attention and stays out of the live-region announcement.
- **Child Chat.** A Delegated Session's own Chat keeps the `Delegated by <title> · <parent Project>`
  bubble and adds an origin row at the top of the composer strip: the origin, that the result goes
  back automatically, and `Back to <parent>`, plus a hint that acting here takes the Session over.
  Once the user holds the Session (`control` is `human`; `takenOverAt` alone for an older Server) the
  row says `You took over this Session` and drops the hint but keeps `Back to <parent>`, and adds
  a small `Hand back` button (tooltip `Let <parent> continue driving this Session`; the navigation
  link stays `Back to <parent>`): disabled with its reason while the parent is archived, the Chat is busy
  or has queued messages, or the composer holds a draft. After a hand-back the row says `Handed back
to <parent> · waiting for it to continue` (`Automatically handed back to <parent>` after an
  automatic hand-back) until the Agent uses the grant, and returns to the delegated wording after
  that. The timeline carries a divider for each entry of `controlChanges` at the first entry at or
  after its time: `You took over`, `Handed back to <parent>`, or `Automatically handed back to
<parent> after you left`, so a user returning to a Session handed back while they were away sees
  where it happened. When the position is uncertain (an earlier entry has no time, earlier history is
  not loaded, or nothing arrived since the change), only the newest change is shown, as a standalone
  marker above the composer instead of a guessed position; an older change is left out.
  While a request waits, the origin row says `Waiting for <parent> to approve` (muted) or, once
  the request is the user's, `Waiting for your approval` (amber), and the request card carries
  the reason line.
  An archived parent stays named but cannot be opened. When the Session's newest task failed with
  a retryable failure, the row offers the same failure actions as the strip (see
  [Failure next steps](#failure-next-steps)).

Privacy: projection metadata, logs, and diagnostics carry IDs and closed enums only. Summaries,
steps, and answer text reach the Renderer through the owner-only reads above and nowhere else.

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

## Delegation history and cost

`list` returns the newest tasks that are still stored, and the store prunes settled tasks that
carry no answer. `caxri agent delegate history` (`agent.delegation.history`) is the durable
counterpart: it finds a task an Agent delegated earlier by words from its Session title or its
summary, newest first.

```sh
caxri agent delegate history --query "login retry" --outcome completed --limit 10 --json
caxri agent delegate history --query "login retry" --outcome completed --after <nextCursor> --json
```

- **Scope.** An Agent sees only the rows its own Terminal created under its exact Endpoint
  generation or in the conversation that Terminal holds now, the same rule as `list` (`isDelegationOwnerPrincipal`, with the Caxri Bot exception for its own
  Terminal). A delegation client sees only its own client and generation. The human owner, Desktop,
  an Extension, and a paired device see every row. The request takes no Session, Project, creator,
  Terminal, or principal; the Internal twin `agent.delegation.historyInternal` carries the
  authenticated authority and lives in the Internal method map, never in the public one.
- **Rows are finished work.** A row is written when a task settles (`completed`,
  `human_intervened`, `interrupted`, `failed`, `answer_unavailable`), inside `save()` but isolated
  from it: a failed history write is logged with a closed reason and the next save of that task
  retries it, so a settle never fails because history did. `blocked` and other active states have no
  row. `history` never claims an answer, so reading it cannot consume a result.
- **Search.** `--query` is 1 to 100 characters, case-insensitive and literal (`%`, `_`, and `\`
  match themselves), and matches only the Session title at settle time (clipped to 200 characters)
  and the stored summary. It never matches a prompt or an answer. A title can echo the first words
  of a prompt, and an `excerpt` summary is the first paragraph of the answer, so both can contain
  answer-derived words; the entry says which with `summarySource`.
- **Paging.** Keyset order is `(created_at, delegation_id)` descending. `nextCursor` is opaque and
  bound to the query, outcome filter, and caller; reusing it with anything else is refused with
  `history_cursor_invalid`. A limit is 1 to 50 (default 20).
- **Retention.** No row is ever deleted by the cap. Beyond the newest 5000 rows by settle time,
  only the searchable text (`title`, `summary`, `summarySource`) is cleared and `compacted` is true;
  identifiers, outcome, failure, provider, times, and counters stay so cost attribution and ID
  recovery keep working. A compacted entry cannot match `--query`. Deleting a Session or pruning the
  task record leaves the row in place (no foreign key).
- **Tokens.** Provider counters only, copied from the receipt; an unreported counter is absent,
  never `0`, and the human output omits the whole tokens line when none was reported. History
  prints no price.

### Provenance edges and delegated cost

`delegation_edges` records, for every Session a Session created as `delegated`, `consult`,
`handoff`, or `independent`, its creator and relation. It is written when the child Session is created, so a
delegation that never settled (a running or deleted one) still has its edge; migration 0008
backfilled the edges of Sessions that already existed. Edges outlive Session deletion on purpose,
so a deleted middle Session does not hide its descendants' spend.

The Delegated Sessions strip uses the edges to state spend:

- `usage.delegationSummary` (owner-only) walks the edges breadth-first from the Chat's Session over
  `delegated` and `consult` children (a `handoff` moves the user's own continuation, and an
  `independent` Session is the creator's separate task; neither is rolled up), visits each Session once, and prices the Usage ledger rows of every visited Session.
  The walk is bounded: at most 1000 descendants (the root does not count) and depth 8. A larger or
  deeper tree sets `isPartial`, so the figure reads as a floor.
- A row shows its child's cost together with the cost of every attempt in its retry chain; the
  header shows the total. `+` means a floor (a model without a list price, or a truncated walk).
  A figure carries no marker while a task below it still runs: every figure is already an estimate,
  so a `~` would read as "about". The accessible description, and the header's tooltip, say instead
  that the figure may still grow. Unknown is never `$0`: a Session whose
  own usage is unknown has no `costUsd` in `usage.sessionCost`, which then carries only the
  `delegated*` fields.
- Figures are estimates at API list prices, not a charge; a subscription plan bills differently.
- The summary reports `isScanPending` while the Usage ledger is still scanning, and the Renderer
  re-reads on a short bounded interval until it lands. A settle also refreshes it through the
  Delegated Sessions feed invalidation.

Privacy: `agent_delegation.history_read` and `agent_delegation.history_recorded` log identifiers,
counts, durations, and closed reasons only. The query text, titles, summaries, and cursors appear in
the reply to the authorized caller and nowhere else.

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

A child that runs in a Terminal correlates its task through its provider's lifecycle hooks, which
are off by default. When the target provider's hooks are not ready for a launch (turned off, or the
installation is unusable), the task fails as `hooks_required` before anything launches, instead of
starting an Agent whose task can never settle. A Chat child reports through its provider protocol
and needs no hooks. The launch-time binding checks the same per-provider readiness, so hook
credentials granted because another provider is enabled never stand in for it.

Grok supports explicit model, reasoning effort, sandbox, permission mode and tool restrictions.
Session selectors, headless modes and unknown overrides fail before launch. An already configured
`--always-approve` or `--yolo` is preserved; Caxri never adds it.

Ordinary automated coverage uses isolated fake providers. Real-provider checks use only the guarded
debug procedure, a fixed synthetic task, and content-free evidence.

# Agent Commander

The Agent Commander is a second Caxri window for delegating work instead of doing it. It has two
parts: a Codex Agent Terminal (the Commander) and a board of every visible Project and Session.
You describe a goal to the Commander. It breaks the goal into tasks, starts a coding Agent for each
one in a visible Session, tracks the Agents, and reports back. Routine product and engineering
decisions stay with the Commander. It asks you only about high-risk decisions, such as a database
schema, a large new feature that needs design, or an irreversible operation.

Open it with **View > Open Agent Commander** or the Command Palette entry
**View: Open Agent Commander**. There is only ever one Commander window, so opening it again just
brings the existing window forward. Clicking a board row selects that Session in the Workbench and
focuses the main window.

## Window and Desktop Main

`AgentCommanderWindowController` (`apps/desktop/src/main/agent-commander-window.ts`) owns the window.
It loads `agent-commander.html` with the Workbench preload and shares Main's single authenticated
Desktop connection. It does not get a second Server connection or a second Desktop lease.
`createAuxiliaryWindow` (`auxiliary-window.ts`) supplies the hardening shared with the Process
Explorer:

- `window.open` is denied.
- Navigation is pinned to the entry URL.
- Console and preload errors are logged under the `agent_commander.*` event group.
- Hangs are observed.
- Crash recovery is bounded, and a crash loop destroys only the Commander window.

The window follows the app-wide `window.zoomLevel` setting. It opens at the current level, and
`createWindowZoomController` (`window-chrome.ts`) applies every later change to it along with the
Workbench, recentering its traffic lights in the zoomed header. View > Zoom In, Zoom Out, and
Actual Size from the focused Commander run on the Workbench, which owns the setting, without
bringing it forward, so the Commander zooms in place. Zoom is the one command a Workbench modal
dialog does not block (`allowBehindModal`), so an open dialog the user cannot see never swallows
it. The Process Explorer follows the same app-wide zoom, the same way.

Closing the window leaves the Commander running, so the user reopens it often. The controller
records the window's bounds after each move and resize and on close, and reopens it there for the
rest of the app run. That bounds/open state also survives an app restart: `app.auxiliaryWindowState`
(`auxiliaryWindowStateSchema`, one combined `app_state` row shared with the Process Explorer) persists
it at quit, `AuxiliaryWindowBoundsMemory` (`auxiliary-window-bounds.ts`) clamps the remembered
rectangle to whichever display it currently matches every time the window opens — not only at
launch — so a monitor unplugged while the app keeps running never reopens the window off-screen,
while the unclamped rectangle is kept so the window returns once that monitor is back, and
`reopenAuxiliaryWindowsAtStartup` (`auxiliary-window-lifecycle.ts`) reopens the
Commander automatically, after the Workbench window's Renderer has actually finished booting (not
merely created) and Server startup is already up, exactly when it was still open at the previous
quit. The Process Explorer remembers its bounds the same way but never
reopens itself; the user opens it again through the same entry points as any other launch.

The window runs with the Desktop principal. Main therefore authorizes it separately, through
`AgentCommanderRendererPolicy` (`agent-commander-policy.ts`) in the `caxri:request` IPC path:

- **Always admitted.** A short read list (`commander.board`, Settings, keybindings, theme,
  `events.recover`), the Commander's own lifecycle (`commander.ensure`, `commander.snapshot`, and
  `agentCommander.stop` for the title bar's Stop button), `external.open`, the Terminal pane's
  context menu (`contextMenu.show`), and two Workbench hand-offs: `agentCommander.revealSession`
  and `agentCommander.openSettings`, which the pane's Open Settings sends when the Agent CLI is
  missing. An optional `target` on `agentCommander.openSettings` (see `settingsTargetSchema` in
  `packages/protocol`) scrolls Settings to one specific row, such as the missing Agent's Executable
  setting, instead of landing on its default view. Each raises the Workbench, reopening it if
  needed, before it acts. Main pops that menu over the Commander window, not the Workbench: the IPC
  boundary records the requesting window (`request-window.ts`) because the command dispatcher
  carries no Electron objects. The menu only reports the chosen entry back, and that entry's action
  is a separate request this policy admits on its own. The window cannot call `commander.stop`
  directly; Main closes the window before it stops the Commander. `app.bootstrap` and
  `app.records` are refused: the window reads its rows only through `commander.snapshot`.
- **Terminal requests** (attach, detach, input, resize, restart, long paste, the pane's
  reference-context read, and `agentCommander.openFileLink`) are admitted only when they name the
  Commander Terminal, and `session.updateState` (the pane's own layout and focus) only when it names
  the Commander Session. Main learns both IDs from the reply to `commander.ensure` or
  `commander.snapshot`.
- **Everything else** is refused with `FORBIDDEN` and logged. That includes file edits, Project and
  Session mutations, Settings writes, and any other Session's Terminal.

Main routes events through the same policy:

- **Durable journal envelopes** (anything with a `cursor`) reach both windows, so each window's
  recovering event client sees a gap-free cursor sequence.
- **Terminal-scoped transient events** (`terminal.output`, `terminal.outputRecovery`,
  `terminal.sizeOwnership`) go only to the window viewing that Terminal.
- **Shared transient events** (`host.connectionChanged`, `sessionPullRequests.changed`) reach both
  windows: a reconnect dropped PTY output to every mounted pane, and the board shows the pull
  requests the second announces. Neither is a command, so delivering it twice runs nothing twice.
- **Other transient events** go only to the Workbench, including `command.execute` and
  `desktop.openRequested`, so a menu accelerator never runs twice.

Each window tracks its own events-ready state.

The Commander window has no Settings, editor, or Git view, so its entry installs a Terminal pane
host (`terminal-pane-host.ts`) before the first render. The pane's Open Settings hands off to the
Workbench, scrolled to the missing Agent's Executable setting. URLs and file paths are links; commit
SHAs get no underline, hint, or Open Detected Link entry (there is no Git view here to open one in),
and a reference's hover card keeps its basic content instead of loading details.

Opening a file link hands off to the Workbench through `agentCommander.openFileLink`, resolved by
the same `terminal.fileLink.resolve` every Terminal uses, unmodified for the Commander. An absolute
path, a `~/...` path, and an explicit `.../` cross-Project search all match by containment across
every added Project; a bare relative link instead falls back to a suffix search scoped to the source
Terminal's own Workbench Root (`apps/server/src/domains/terminal/file-links.ts`). The Commander's own
Workbench Root is its hidden system Project, so a bare relative path in its own Terminal output will
not match a file that lives in a different, visible Project — only an absolute, `~/...`, or
explicitly cross-Project link does. This is an existing property of the shared resolver, not
something this hand-off changes. The Commander's own cwd is its hidden system Project, so this
hand-off must never grant it authority over another Project: Main always substitutes a real, visible
Session for the Commander's own before opening anything, in `workbench-root-authority.ts`'s
`pickCommanderFileLinkSession` (path resolves inside a Project: prefers a Session the Commander
itself created, then the Workbench's current selection, then the first) and `pickAnyVisibleSessionId`
(path resolves outside every Project: any live Session, to host the read-only ephemeral tab). An
ambiguous resolution answers the Commander's own already-mounted link picker without raising the
Workbench; every other branch raises it first, so the external-file confirmation dialog and the
opened editor both land on a window the user can see.

The Workbench accepts drops on its pane surface, which this window does not mount, so the Commander
Terminal accepts them itself (`commander-terminal.tsx`) through the same drop-to-input rule while it
runs. A file dropped from Finder, usually a bug screenshot for the Commander to hand on, inserts its
path, and so does a Files entry, Editor tab, or Project dragged over from the Workbench.

Closing or reloading the Commander window detaches its view of the Commander Terminal, but the PTY
keeps running and the next window re-attaches from a snapshot. Closing the main window detaches
every Terminal view, the Commander's included, and then closes the Commander window.

The native menu belongs to the whole app, and its command items act on the Workbench. While the
Commander window (or the Process Explorer) is focused, Main therefore routes them by the focused
window (`apps/desktop/src/main/menu.ts`): Close Tab (`Cmd+W`) closes the focused window, a shortcut
typed there is dropped except the app-level Settings shortcut, and an item picked from the menu bar
brings the Workbench forward before it runs.

Terminal chords such as Find (`Cmd+F`), Clear (`Cmd+Shift+K`), and Restart (`Cmd+Shift+R`) have no
native accelerator; the focused Renderer dispatches them. The Commander window does not mount the
Workbench's dispatcher, whose Terminal commands resolve the active Terminal from a pane layout this
window lacks. Its own dispatcher (`features/agent-commander/commander-shortcuts.ts`) resolves the
user's keybindings narrowed to the actions its Terminal context menu offers, Clear, Find in
Terminal, and Open Detected Link, plus the Restart an exited pane shows with its shortcut. As in the
Workbench, Restart does not reach through a focused Terminal or input, so a stray `Cmd+Shift+R`
never replaces a running Commander; a stopped Terminal gives up focus, and the shortcut then works.
Every other chord reaches the focused surface untouched.

A notification raised in this window can run only the follow-ups it has a surface for
(`commander-toast-actions.ts`): the pane's Retry and Refresh, and the Open Settings of the notice
that pins the Commander Terminal to software rendering, which hands off to the Workbench like the
pane's own Open Settings. Any other follow-up keeps the fail-closed answer.

While the Commander runs, the Workbench status bar shows a muted `Commander` chip with its state
(`starting`, `working`, `needs input`, or `idle`) from `commander.status`; clicking it opens the
window. A stopped Commander shows no chip. **View > Stop Agent Commander** (also in the Command
Palette) and the window's **Stop** button run `agentCommander.stop`: Main closes the window, then
calls `commander.stop`. Main logs a failed stop as `agent_commander.stop_failed` with its error
code.

## Server model

The Commander runs in real rows: a system Project, one Session, and one Codex Terminal. As a result it
reuses the ordinary PTY, Agent Endpoint, hook, and restore machinery. These rows are recorded in the
`app_state.agentCommander` cell, together with the IDs of the Sessions the Commander has created.
Readers go through `agentCommanderRows` (`apps/server/src/domains/db/commander-rows.ts`), which
trusts only IDs whose rows still exist.

Every Workbench-facing read excludes the Commander rows:

- `listVisibleProjects` and `listVisibleSessions`, and therefore bootstrap, CLI queries,
  pull-request lookup, and status polling;
- targeted `app.records` refreshes;
- selection fallback after a deletion;
- idle Terminal suspension. The Commander Session is never selected in the Workbench, so without
  this exemption it would always look abandoned.

The Commander window reads its own rows through `commander.snapshot`. This is a Workbench-shaped
snapshot scoped to the Commander, so the ordinary Terminal pane runs against it unchanged.

`commander.ensure` is desktop-only and idempotent. It prepares the Commander workspace directory
for the current profile, including a generated `AGENTS.md` that teaches the Commander its workflow
and its CLI commands, and runs `git init` there on every call, which completes a half-written
repository and never overwrites an existing one. Codex resolves its project root, project
configuration, hooks, and `AGENTS.md` hierarchy from the nearest `.git` above its working directory,
so without its own repository the Commander would inherit whichever repository contains the
profile: a worktree development profile lives inside the Caxri checkout's `.git`, whose hooks fail
there. When Git is missing or `git init` fails, the Commander still starts and Server Core logs
`agent_commander.workspace_repository_failed` with a `git_missing` or `init_failed` reason. It then
creates any missing Commander row.

Every launch of the Commander Terminal (first launch, restore, and restart) trusts the workspace for
that Codex process only, with a `-c projects={ "<workspace>" = { trust_level = "trusted" } }`
override (`apps/server/src/domains/commander/launch.ts`). Without it the first launch on a machine,
and on every new development profile, stops at Codex's folder-trust prompt. The workspace holds only
generated instructions and the Commander's notes, so this grants what answering the prompt would:
project configuration, hooks, and Codex's sandbox defaults for a trusted project. Nothing is written
to the user's `~/.codex/config.toml`, so profiles never accumulate trust entries there. The override
applies only to the Terminal recorded as the Commander, never to delegated or Workbench Agents. The Terminal is launched only when
it was just created. An existing Terminal that an app restart or suspension interrupted is resumed
through a dedicated restore supervisor: the Workbench resumes Terminals only for the Session it
selects, and it never selects the Commander Session. The same restore resumes a Commander the user
stopped. A Terminal that exited on its own stays as it is; the pane's own Resume and Restart actions
relaunch it. A Server Core restart takes the Commander's PTY with it, so an open Commander window
runs `commander.ensure` again once the runtime is ready or Desktop reconnects to a replaced Server;
a window that is closed leaves the Commander parked until the next ensure.

`commander.stop` is desktop-only and idempotent. It drops any queued Commander restore and waits
for one that is already spawning, then kills the PTY behind the same barrier a suspension uses and
parks the Terminal as `detached`, keeping its row, final screen, and bound Codex conversation. Only
an explicit `commander.ensure` resumes it; an app restart does not. A stop racing an ensure is
ordered: a stop waits for the Terminal the first ensure creates, and an ensure that arrives during a
stop runs after it and restores what it parked. Sessions the Commander delegated into keep running;
their receipts wait for the Commander's next turn.

`commander.status` is a content-free read for the status bar. The Commander is Codex inside a Shell
PTY, and Codex can exit while the Shell lives on, so it reads `stopped` unless both processes are
live, whatever its Session last reported. A live Commander reads `starting`, or mirrors the
Commander Session's activity as `working`, `waiting`, or `idle`. Every `state.changed` event
invalidates it in the Workbench, because Workbench records exclude the Commander's rows and no
record-scoped event names them.

The board (`commander.board`) projects every non-archived Session in a visible top-level Project
into one of six groups, in this order: `attention`, `working`, `waiting`, `failed`, `finished`, and
`idle`. Each row carries:

- the primary Agent's process state: the Agent CLI's own state while its Shell is up, because an
  Agent can exit and leave its Shell running. A turn recorded as running or waiting without a live
  Agent groups as `idle`, and the window shows it as exited rather than working;
- the cached pull request from the `session.pullRequests` snapshot, with the snapshot's
  `pullRequestsRefreshedAt`. When the last lookup failed the window hides the pull request, as the
  Activity view does, because its state and checks may be stale;
- whether the Commander created the Session;
- for a Commander Session, its current Commander task: its delegation ID, status, failure reason,
  and update time. An unsettled task (running or blocked) wins over a settled one, and the newest
  wins otherwise. A follow-up is admitted only after its parent settled, so a continued task shows
  its newest link, and a follow-up rejected because its parent still runs never hides that parent.
  Only receipt state leaves the database; the
  task's prompt and answer never reach the board. The window prints it next to the `Commander`
  marker as `Starting`, `Running`, `Answered`, `Blocked`, `Taken over`, `Stopped`, or `Failed`.
  A task `blocked` with `startup_waiting` reads `Needs you` and moves its row to `attention`: its
  Agent is running but waits at startup, usually on a first-run prompt only the user can answer.
  A `failed` or `answer_unavailable` task moves its row to `failed`, since a task that never
  started often left no Session activity to group by.
  `Answered` means the Agent gave its final answer, not that the Commander verified it.

The board never waits on GitHub. The window refetches the board, debounced, on every `state.changed`,
and polls it every 10 seconds while visible so cached pull request and CI state keeps moving even
when an event is missed. A `sessionPullRequests.changed` event does not refetch the board: the
window reads the `session.pullRequests` snapshot once per debounce window and patches only the rows
of the Sessions the event named (`refreshCommanderBoardPullRequests`). Every other row keeps its
object, so a new, merged, or unavailable pull request repaints one row rather than the whole board.
The Commander window reads that snapshot itself because it does not mount the Workbench window's
query invalidation. Delegation receipts announce themselves rather than waiting for
that poll: creating a task, or changing its status or failure reason, sends a `state.changed` naming
the task's Session, because many of those transitions (a startup deadline, an asynchronous result
collection, a rejected follow-up) change no Session or Terminal record. Saves that only advance
bookkeeping stay silent, as does Server restart recovery: Desktop windows reload their state on
reconnect, and a later `status` or `wait` reads the recovered receipt directly.

### Completion notices

`CommanderCompletionNotifier` (`apps/server/src/domains/commander/completion-notice.ts`) pushes a
delegation's completion, failure, or need for input straight into the Commander Terminal, so the
Commander no longer has to poll `agent delegate wait` in a loop to learn that a task it dispatched
is done. This is a Server Core-owned exception to the peer-message rule described in
[Agent messaging](../.agents/skills/project-architecture/references/agent-messaging.md): the text
is Server-generated only (a delegation ID, a Session ID, and a closed status word), never a
transcript or Agent-authored text, and it can never grant a permission, change a setting, or invoke
a slash command.

A transition only reaches the Terminal once every one of these holds, reusing exactly the fence
`AgentDelegationService` already applies before resuming a follow-up (`service.ts` ~260-300, 764):

- the finished turn's idle proof (`AgentCoordinator.hasIdleProof`) matches the exact launch and turn
  that just settled, proving Codex actually finished a real turn rather than a permission dialog or
  an unfinished native operation;
- the Terminal's input epoch (`TerminalManager.inputEpoch`) is unchanged since that turn **started**,
  so a draft typed mid-turn, or typed into the Commander after it went idle, defers delivery instead
  of risking an unwanted Enter. The injected write itself never bumps this epoch;
- the Commander's own Session has no pending permission prompt (`lastActivityState` is not
  `waiting`). Its unread flag is deliberately ignored: every settled Commander turn marks its own
  Session unread, and the Commander window never marks it read.

A transition that arrives while any of these fails stays queued and is retried the next time the
Commander reaches a clean idle point; several transitions queued at once coalesce into one line. A
successful delivery also consumes the settled-turn identity it just proved idle against, so at most
one line is ever injected per proven-idle turn: the injected write never bumps the input epoch and
does not invalidate the idle proof, so without consuming that identity a second, closely timed
transition could otherwise reuse it and write a second time before Codex has actually started a fresh
turn to read the first line.

Delivery is deduplicated by delegation ID and the receipt revision that produced it, and is fenced to
the Commander Terminal's current launch, so a Codex relaunch mid-flight cannot double-send: at most
one notice per settled transition, never two. The residual risk is the same in-flight-keystroke race
every exact-launch write already accepts (a keystroke sent in the same event-loop turn as the write,
before its epoch bump is observed). Pending notices live only in Server Core memory: an undelivered
one does not survive a Codex relaunch or a Server restart, and `commander board` plus the delegation
CLI reads are the compensation for that loss.

## How the Commander works

The generated `AGENTS.md` (`COMMANDER_INSTRUCTIONS` in
`apps/server/src/domains/commander/workspace.ts`) is the Commander's whole operating manual. It is
rewritten on every `commander.ensure`, so an upgrade replaces it. The Commander keeps its own state
in the workspace instead: `ledger.md` has one line per task, and `tasks/` holds one task file per
delegation.

- **Intake.** Requests are expected to be short: an issue link, a screenshot, or a one-line symptom,
  and most of them bug fixes. The Commander reads linked issues itself and writes down everything a
  screenshot shows, because the delegated Agent starts with no context.
- **Dispatch.** Each task gets its own Commander Session and task file. The task tells the Agent to
  follow the target repository's own `AGENTS.md` and delivery flow, work on its own branch, deliver a
  pull request with green checks, and not merge, release, or deploy unless the user asked.
- **Bug reports.** A bug task must reproduce first and finish with the reproduction, the root cause
  with file references, the fix, evidence (a test, measurements, or screenshots), and the blast
  radius. When a report lacks reproduction or evidence, the Commander sends a follow-up before it
  calls the pull request ready.
- **Escalation.** The Commander asks the user only about product or scope choices, table
  definitions and large features, destructive or credential-bearing operations, genuinely ambiguous
  requests, and steps that need the user's hands. It decides routine questions itself and answers
  the delegated Agents' routine questions with follow-ups.
- **Reporting.** It speaks only when something completes, needs the user, or fails. Each ready pull
  request is reported with the bug, cause, fix, evidence and the commit it was gathered on, and risk,
  so the user can decide to merge in under a minute. Before calling one ready, the Commander reads it
  live with `gh pr view`, because the board's copy is cached and has no head commit: it must be
  `MERGEABLE`, every check must have passed, and its `headRefOid` must be the commit the delegated
  Agent verified. A moved head gets one re-verification follow-up; a head that keeps moving is
  reported as not ready rather than chased.
- **Boundaries.** The Commander works only through the Caxri CLI and read-only tools. It never
  edits the user's repositories, reads Caxri's own profile, or operates the user's screen.

## Authority

When domain services launch the Commander Terminal, they begin its Agent Endpoint with
`role: 'commander'`. That role adds two fixed capabilities: `commander` and `agents.delegate`. Its
Project scope stays the Commander's own system Project, so `agent:control`, dispatch, steer, and
Settings writes are never implied.

- `commander.board` requires `commander`.
- `commander.session.create` requires `commander`. It creates an empty Session in a visible
  top-level Project without changing the Workbench selection, and records the Session as a
  Commander Session. Once the Commander owns 1,000 existing Sessions it refuses with `CAPACITY`
  rather than disowning the oldest, which may still run a task; deleting Sessions frees room.
- `agent.delegation.create` and `agent.delegation.presets` skip Server Core's Project-scope check
  only for a `commander` Agent principal. The delegation domain then admits the request only when
  all of these hold:
  - the caller is the exact recorded Commander Terminal in the Commander Project;
  - the target is a non-archived Commander Session;
  - that Session is in a visible top-level Project.

  A busy user Session is refused, because a delegated pane would split its active layout.

- A delegation whose caller is outside the target Session fills that Session's empty pane, the same
  way an external delegation caller does. It uses the target's working directory, not the
  Commander's.
- Ownership stays with the Commander Terminal. A Caxri restart or Codex relaunch starts a new
  Endpoint generation of that same Terminal, and status, result, wait, stop, and follow-up keep
  working for every task it delegated earlier. Any other Agent's tasks stay fenced to the exact
  generation that created them.

The human CLI owner also holds `commander`, so an operator can read the board or create a Commander
Session from a shell.

## CLI

```bash
caxri commander board --json
caxri commander session create --project <project-id> --json
caxri agent delegate create --project <project-id> --session <session-id> --prompt-file task.md --provider codex --json
```

Inside the Commander Terminal, the Commander calls the version-matched CLI through
`node "$CAXRI_CLI_PATH"` using its Endpoint credentials. A human owner is asked to confirm
`commander session create`; the Commander's own call needs no confirmation. See [CLI](cli.md) and
[Agent delegation](agent-delegation.md).

## Known limits and follow-ups

- Commander identity lives in an `app_state` cell rather than a Project column, by decision.
  `agentCommanderRows` (`apps/server/src/domains/db/commander-rows.ts`) checks that the Project,
  Session, and Terminal still belong together, every Workbench list excludes the stored Project ID,
  and `commander.ensure` rebuilds a missing record. A `projects` role column would add a migration
  without fixing a known defect. Revisit it when a second kind of system Project appears or a real
  integrity defect does.
- Stopping the Commander ends its current turn. Reopening resumes the conversation, not the turn.
- There is no setting to stop the Commander whenever its window closes. The status bar chip and the
  explicit Stop cover the single-maintainer workflow; add one only when a real need appears.
- The Commander runs with the user's own Codex configuration, including its sandbox mode. Endpoint
  capabilities are product authorization, not a filesystem sandbox for processes of the same OS
  user.
- The Commander delegates only into empty Sessions it created. It cannot yet queue work into an
  existing Session, and it does not own a persistent to-do queue.
- A completion notice's pending queue is in-memory only (see "Completion notices" below), so an
  undelivered notice does not survive a Codex relaunch or a Server restart. `commander board` and
  `agent delegate status`/`agent delegate wait` remain the recovery path for that gap, the same way
  they were the Commander's only path before this feature.

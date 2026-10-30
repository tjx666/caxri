---
kind: living
status: current
---

# Caxri Bot

Caxri Bot is a second Caxri window for delegating work instead of doing it. It has two
parts: an Agent Terminal running Codex or Claude Code (Caxri Bot) and a board of every visible
Project and Session.
You describe a goal to Caxri Bot. It breaks the goal into tasks, starts a coding Agent for each
one in a visible Session, tracks the Agents, and reports back. Routine product and engineering
decisions stay with Caxri Bot. It asks you only about high-risk decisions, such as a database
schema, a large new feature that needs design, or an irreversible operation.

Open it with **View > Open Caxri Bot** or the Command Palette entry
**View: Open Caxri Bot**. There is only ever one Caxri Bot window, so opening it again just
brings the existing window forward. Clicking a board row selects that Session in the Workbench and
focuses the main window.

## Window and Desktop Main

`CaxriBotWindowController` (`apps/desktop/src/main/caxri-bot-window.ts`) owns the window.
It loads `caxri-bot.html` with the Workbench preload and shares Main's single authenticated
Desktop connection. It does not get a second Server connection or a second Desktop lease.
`createAuxiliaryWindow` (`auxiliary-window.ts`) supplies the hardening shared with the Process
Explorer:

- `window.open` is denied.
- Navigation is pinned to the entry URL.
- Console and preload errors are logged under the `caxri_bot.*` event group.
- Hangs are observed.
- Crash recovery is bounded, and a crash loop destroys only Caxri Bot window.

The window follows the app-wide `window.zoomLevel` setting. It opens at the current level, and
`createWindowZoomController` (`window-chrome.ts`) applies every later change to it along with the
Workbench, recentering its traffic lights in the zoomed header. View > Zoom In, Zoom Out, and
Actual Size from the focused Caxri Bot run on the Workbench, which owns the setting, without
bringing it forward, so Caxri Bot zooms in place. Zoom is the one command a Workbench modal
dialog does not block (`allowBehindModal`), so an open dialog the user cannot see never swallows
it. The Process Explorer follows the same app-wide zoom, the same way.

The window reports its own macOS fullscreen state as `window.fullScreen` with
`window: 'caxriBot'`; the Workbench publishes the same event as `window: 'workbench'`, and
each Renderer applies only its own because both receive every durable event. In fullscreen the
title bar drops the traffic-light clearance and shows the Caxri logo, like the Workbench sidebar
header.

Closing the window leaves Caxri Bot running, so the user reopens it often. The controller
records the window's bounds after each move and resize and on close, and reopens it there for the
rest of the app run. That bounds/open state also survives an app restart: `app.auxiliaryWindowState`
(`auxiliaryWindowStateSchema`, one combined `app_state` row shared with the Process Explorer) persists
it at quit, `AuxiliaryWindowBoundsMemory` (`bounds.ts`) clamps the remembered
rectangle to whichever display it currently matches every time the window opens: not only at
launch, so a monitor unplugged while the app keeps running never reopens the window off-screen,
while the unclamped rectangle is kept so the window returns once that monitor is back, and
`reopenAuxiliaryWindowsAtStartup` (`lifecycle.ts`) reopens the
Caxri Bot automatically, after the Workbench window's Renderer has actually finished booting (not
merely created) and Server startup is already up, exactly when it was still open at the previous
quit. The Process Explorer remembers its bounds the same way but never
reopens itself; the user opens it again through the same entry points as any other launch.

The window runs with the Desktop principal. Main therefore authorizes it separately, through
`CaxriBotRendererPolicy` (`caxri-bot-policy.ts`) in the `caxri:request` IPC path:

- **Always admitted.** A short read list (`bot.board`, Settings, keybindings, theme,
  `events.recover`), Caxri Bot's own lifecycle (`bot.ensure`, `bot.snapshot`,
  `caxriBot.stop` for **Stop Caxri Bot**, and `bot.switchAgent`), Clear Caxri Bot Data
  (`bot.data` and `caxriBot.clearData`, which still passes Main's native confirmation),
  `external.open`, the Terminal pane's
  context menu (`contextMenu.show`), and two Workbench hand-offs: `caxriBot.revealSession`
  and `caxriBot.openSettings`, which the pane's Open Settings sends when the Agent CLI is
  missing. An optional `target` on `caxriBot.openSettings` (see `settingsTargetSchema` in
  `packages/protocol`) scrolls Settings to one specific row, such as the missing Agent's Executable
  setting, instead of landing on its default view. Each raises the Workbench, reopening it if
  needed, before it acts. Main pops that menu over Caxri Bot window, not the Workbench: the IPC
  boundary records the requesting window (`request-window.ts`) because the command dispatcher
  carries no Electron objects. The menu only reports the chosen entry back, and that entry's action
  is a separate request this policy admits on its own. The window cannot call `bot.stop`
  directly; Main closes the window before it stops Caxri Bot. `app.bootstrap` and
  `app.records` are refused: the window reads its rows only through `bot.snapshot`.
- **Terminal requests** (attach, detach, input, resize, restart, long paste, the pane's
  reference-context read, `caxriBot.openFileLink`, `terminal.switchSurface`, the Chat
  pane's `agentChat.*` requests, and the Chat composer's `agentActions.list`/`agentActions.read`)
  are admitted only when they name Caxri Bot Terminal, and `session.updateState` (the pane's
  own layout and focus) only when it names Caxri Bot Session. Main learns both IDs from the
  reply to `bot.ensure` or `bot.snapshot`. The admitted Chat requests are `read`,
  `send`, `respond`, `configure`, `interrupt`, `runCommand`, `readImage`, `readTask`, `stopTask`,
  `removeQueued`, `restoreQueued`, `editQueued`, `takeQueued`, `sendQueuedNow`, `resumeQueue`, `saveLongPaste`, `rewind` (Edit from here), and
  `restoreFiles` (Restore code to here), and `previewRestoreFiles` (its read-only dry run). `agentChat.confirmRevertFiles`, the native confirmation
  before either reverts files, names no Terminal and is admitted on its own, since it only returns
  the answer.
- **Fork is not available in Caxri Bot window.** `agentChat.fork` is refused even for the
  Caxri Bot Terminal, and the Chat pane hides Fork from here there (`host="bot"` on
  `AgentChatTerminalContent`, read through `agentChatHostCapabilities`): a fork opens a new Session in the hidden Caxri Bot system Project
  and selects it, and this window has no Workbench to show it. Every `agentChat.*` method in the
  protocol registry must be classified as admitted or refused in `caxri-bot-policy.ts`; a
  unit test fails until a new one is.
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

Caxri Bot window has no Settings, editor, or Git view, so its entry installs a Terminal pane
host (`terminal-pane-host.ts`) before the first render. The pane's Open Settings hands off to the
Workbench, scrolled to the missing Agent's Executable setting. URLs and file paths are links; commit
SHAs get no underline, hint, or Open Detected Link entry (there is no Git view here to open one in),
and a reference's hover card keeps its basic content instead of loading details.

Opening a file link hands off to the Workbench through `caxriBot.openFileLink` (a link to a directory
reveals it in the Workbench's Files explorer instead of opening an editor), resolved by
the same `terminal.fileLink.resolve` every Terminal uses, unmodified for Caxri Bot. An absolute
path, a `~/...` path, and an explicit `.../` cross-Project search all match by containment across
every added Project; a bare relative link instead falls back to a suffix search scoped to the source
Terminal's own Workbench Root (`apps/server/src/domains/terminal/file-links.ts`). Caxri Bot's own
Workbench Root is its hidden system Project, so a bare relative path in its own Terminal output will
not match a file that lives in a different, visible Project: only an absolute, `~/...`, or
explicitly cross-Project link does. This is an existing property of the shared resolver, not
something this hand-off changes. Caxri Bot's own cwd is its hidden system Project, so this
hand-off must never grant it authority over another Project: Main always substitutes a real, visible
Session for Caxri Bot's own before opening anything, in `workbench-root-authority.ts`'s
`pickBotFileLinkSession` (path resolves inside a Project: prefers a Session Caxri Bot
itself created, then the Workbench's current selection, then the first) and `pickAnyVisibleSessionId`
(path resolves outside every Project: any live Session, to host the ephemeral tab). An
ambiguous resolution answers Caxri Bot's own already-mounted link picker without raising the
Workbench; every other branch raises it first, so the external-file confirmation dialog and the
opened editor both land on a window the user can see.

The Workbench accepts drops on its pane surface, which this window does not mount, so Caxri Bot
Terminal accepts them itself (`bot-terminal.tsx`) through the same drop-to-input rule while it
runs. A file dropped from Finder, usually a bug screenshot for Caxri Bot to hand on, inserts its
path, and so does a Files entry, Editor tab, or Project dragged over from the Workbench.

Caxri Bot Terminal can run as a Terminal or as an [Agent Chat](agent-chat.md), like any Codex or
Claude Code Terminal in the Workbench. The title bar's surface toggle and the Switch Agent
Surface shortcut (`terminal.switchAgentSurface`, `Cmd+Shift+J` by default) flip it through `terminal.switchSurface`, which keeps the bound
conversation. In Chat mode the window mounts the same `AgentChatTerminalContent` the Workbench
pane uses and subscribes to `agentChat.patch` itself. The Chat's file-change Open in Editor stays
unavailable here, because the window mounts no pane session. For the same reason the Chat opens
nothing beside itself (`canOpenBesideChat` in `agentChatHostCapabilities`): background work lists
each subagent and shell as a plain row that can still be stopped, timeline rows do not link to their
task, and a turn's file changes offer no Review, so no tab is ever written into Caxri Bot
Session's layout where nothing would show it.

Closing or reloading Caxri Bot window detaches its view of Caxri Bot Terminal, but the PTY
keeps running and the next window re-attaches from a snapshot. Closing the main window detaches
every Terminal view, Caxri Bot's included, and then closes Caxri Bot window.

The native menu belongs to the whole app, and its command items act on the Workbench. While the
Caxri Bot window (or the Process Explorer) is focused, Main therefore routes them by the focused
window (`apps/desktop/src/main/menu/template.ts`): Close Tab (`Cmd+W`) closes the focused window, a shortcut
typed there is dropped except the app-level Settings shortcut, and an item picked from the menu bar
brings the Workbench forward before it runs. The Command Palette (`Cmd+Shift+P`) is the exception:
it opens Caxri Bot's own palette (see [Title bar and Command Palette](#title-bar-and-command-palette)).

Terminal chords such as Find (`Cmd+F`), Clear (`Cmd+Shift+K`), and Restart (`Cmd+Shift+R`) have no
native accelerator; the focused Renderer dispatches them. Caxri Bot window does not mount the
Workbench's dispatcher, whose Terminal commands resolve the active Terminal from a pane layout this
window lacks. Its own dispatcher (`features/caxri-bot/bot-shortcuts.ts`) resolves the
user's keybindings narrowed to the actions its Terminal context menu offers, Clear, Find in
Terminal, and Open Detected Link, plus the Restart an exited pane shows with its shortcut. As in the
Workbench, Restart does not reach through a focused Terminal or input, so a stray `Cmd+Shift+R`
never replaces a running Caxri Bot; a stopped Terminal gives up focus, and the shortcut then works.
It also runs the Chat composer's model menu, permission menu, and plan mode toggle
(`agentChat.changeModel`, `agentChat.changePermissionMode`, `agentChat.togglePlanMode`) while the
Caxri Bot shows a Chat that offers them. Every other chord reaches the focused surface untouched.

A notification raised in this window can run only the follow-ups it has a surface for
(`bot-toast-actions.ts`): the pane's Retry and Refresh, and the Open Settings of the notice
that pins Caxri Bot Terminal to software rendering, which hands off to the Workbench like the
pane's own Open Settings. Any other follow-up keeps the fail-closed answer.

While Caxri Bot runs, the Workbench status bar shows a muted `Caxri Bot` chip with its state
(`starting`, `working`, `needs input`, or `idle`) from `bot.status`; clicking it opens the
window. A stopped Caxri Bot shows no chip. While the Inbox holds open items, a second muted chip
reads `1 needs you` or `N need you` and opens the window; it is never hidden for width, because the
main window has no other trace that Caxri Bot is waiting on the owner. **View > Stop Caxri Bot** (also in the Command
Palette) and **Stop Caxri Bot** in the window's More menu and palette run `caxriBot.stop`: Main closes the window, then
calls `bot.stop`. Every entry asks **Stop the running turn?** (**Stop and Close**) first while the
Caxri Bot is working; the menu and the Command Palette run in the Workbench, which reads
`bot.status` because it cannot see Caxri Bot's Terminal. Main logs a failed stop as `caxri_bot.stop_failed` with its error
code.

## Title bar and Command Palette

The title bar keeps only the controls used all the time: Caxri Bot's Agent chip, the surface
toggle, the **Sessions** and **Needs you** column toggles, and a **More** (`⋯`) menu. More holds the
Command Palette, **Clear Caxri Bot Data…**, and **Stop Caxri Bot**, so a rarely used and
destructive command is never one stray click away.

The window has its own Command Palette (`bot-command-palette.tsx`), on the Workbench palette's
picker shell and row layout. Its rows (`bot-palette.ts`) are grouped as **Caxri Bot** (switch
the Agent, Hand Over to Caxri Bot, Clear Caxri Bot Data, Open Settings, Stop), **View** (each
column toggle names the state it moves to, plus the board scope), and **Agent** (Caxri Bot
Terminal's own commands, such as Find, Clear, Open Detected Link, and Restart, each with its
shortcut). Typing a Session title also lists the board's Sessions, and choosing one reveals it in the
Workbench.

`Cmd+Shift+P` is a native menu accelerator, so no Renderer ever sees the key. While Caxri Bot
window is focused, Main forwards the menu item to it as the transient event
`caxriBot.commandPaletteRequested` instead of raising the Workbench palette behind it
(`openWindowCommandPalette` in `apps/desktop/src/main/menu/template.ts`, wired by
`caxriBotMenuOptions` in `caxri-bot-window.ts`). The forward reaches only that window;
the Workbench ignores the event.

## Server model

Caxri Bot runs in real rows: a system Project, one Session, and one Agent Terminal. As a result it
reuses the ordinary PTY, Agent Endpoint, hook, and restore machinery. These rows are recorded in the
`app_state.caxriBot` cell, together with the IDs of the Sessions Caxri Bot has created.
Readers go through `caxriBotRows` (`apps/server/src/domains/db/bot-rows.ts`), which
trusts only IDs whose rows still exist.

Every Workbench-facing read excludes Caxri Bot rows:

- `listVisibleProjects` and `listVisibleSessions`, and therefore bootstrap, CLI queries,
  pull-request lookup, and status polling;
- targeted `app.records` refreshes;
- selection fallback after a deletion;
- idle Terminal suspension. Caxri Bot Session is never selected in the Workbench, so without
  this exemption it would always look abandoned.

Caxri Bot window reads its own rows through `bot.snapshot`. This is a Workbench-shaped
snapshot scoped to Caxri Bot, so the ordinary Terminal pane runs against it unchanged.

`bot.ensure` is desktop-only and idempotent. It prepares Caxri Bot's workspace directory
(`<profile>/caxri-bot`; a workspace left at the feature's former name, `agent-commander`, is moved
there with its `memory/` notes) for the current profile, including a generated `AGENTS.md` that teaches Caxri Bot its workflow
and its CLI commands, and runs `git init` there on every call, which completes a half-written
repository and never overwrites an existing one. Codex resolves its project root, project
configuration, hooks, and `AGENTS.md` hierarchy from the nearest `.git` above its working directory,
so without its own repository Caxri Bot would inherit whichever repository contains the
profile: a worktree development profile lives inside the Caxri checkout's `.git`, whose hooks fail
there. When Git is missing or `git init` fails, Caxri Bot still starts and Server Core logs
`caxri_bot.workspace_repository_failed` with a `git_missing` or `init_failed` reason. It then
creates any missing Caxri Bot row.

Every launch of Caxri Bot's Terminal on Codex (first launch, restore, and restart) trusts the workspace for
that Codex process only, with a `-c projects={ "<workspace>" = { trust_level = "trusted" } }`
override (`apps/server/src/domains/bot/launch.ts`). Without it the first launch on a machine,
and on every new development profile, stops at Codex's folder-trust prompt. The workspace holds only
generated instructions and Caxri Bot's notes, so this grants what answering the prompt would:
project configuration, hooks, and Codex's sandbox defaults for a trusted project. Nothing is written
to the user's `~/.codex/config.toml`, so profiles never accumulate trust entries there. The override applies only to the Terminal recorded as Caxri Bot, never to delegated or Workbench Agents. A
Caxri Bot on Claude Code is trusted through Claude Code's own config instead (see
[Caxri Bot's Agent](#caxri-bots-agent)). The Terminal is launched only when
it was just created. An existing Terminal that an app restart or suspension interrupted is resumed
through a dedicated restore supervisor: the Workbench resumes Terminals only for the Session it
selects, and it never selects Caxri Bot's Session. The same restore resumes Caxri Bot if the user
stopped it. A Terminal that exited on its own stays as it is; the pane's own Resume and Restart actions
relaunch it. A Server Core restart takes Caxri Bot's PTY with it, so an open Caxri Bot window
runs `bot.ensure` again once the runtime is ready or Desktop reconnects to a replaced Server;
a window that is closed leaves Caxri Bot parked until the next ensure.

`bot.stop` is desktop-only and idempotent. It drops any queued Caxri Bot restore and waits
for one that is already spawning, then kills the PTY behind the same barrier a suspension uses and
parks the Terminal as `detached`, keeping its row, final screen, and bound conversation. Only
an explicit `bot.ensure` resumes it; an app restart does not. A stop racing an ensure is
ordered: a stop waits for the Terminal the first ensure creates, and an ensure that arrives during a
stop runs after it and restores what it parked. Sessions Caxri Bot delegated into keep running;
their receipts wait for Caxri Bot's next turn.

A Chat Caxri Bot keeps the same identity. A Chat process has no PTY lifecycle environment, so
`AgentChatService` asks its optional `endpoint` (`apps/server/src/domains/agent-chat/endpoint/agent-endpoint.ts`)
for the launch environment, activates the generation once the provider is ready, and retires it when
the process exits or never started (`agent-chat/endpoint/lease.ts`). Every Chat receives an
Endpoint; only the recorded Caxri Bot Terminal's carries the `bot` role. `bot.stop` parks a Chat Caxri Bot through `agentChat.closeSession(..., 'detached')`
instead of suspending a PTY, and Caxri Bot restore resumes that detached Chat as well.

`bot.status` is a content-free read for the status bar. Caxri Bot is an Agent CLI inside a
Shell PTY, and the Agent can exit while the Shell lives on, so it reads `stopped` unless both processes are
live, whatever its Session last reported. A live Caxri Bot reads `starting`, or mirrors the
Caxri Bot Session's activity as `working`, `waiting`, or `idle`. Every `state.changed` event
invalidates it in the Workbench, because Workbench records exclude Caxri Bot's rows and no
record-scoped event names them.

The board (`bot.board`) projects every non-archived Session in a visible top-level Project
into one of six groups, in this order: `attention`, `working`, `waiting`, `failed`, `finished`, and
`idle`. Each row carries:

- the primary Agent's process state: the Agent CLI's own state while its Shell is up, because an
  Agent can exit and leave its Shell running. A turn recorded as running or waiting without a live
  Agent groups as `idle`, and the window shows it as exited rather than working;
- the cached pull request from the `session.pullRequests` snapshot, with the snapshot's
  `pullRequestsRefreshedAt`. When the last lookup failed the window hides the pull request, as the
  Activity view does, because its state and checks may be stale;
- whether Caxri Bot created the Session;
- for a Caxri Bot Session, its current Caxri Bot task: its delegation ID, status, failure reason,
  and update time. An unsettled task (running or blocked) wins over a settled one, and the newest
  wins otherwise. A follow-up is admitted only after its parent settled, so a continued task shows
  its newest link, and a follow-up rejected because its parent still runs never hides that parent.
  Only receipt state leaves the database; the
  task's prompt and answer never reach the board. The window prints it next to the `Caxri Bot`
  marker as `Starting`, `Running`, `Answered`, `Blocked`, `Taken back`, `Stopped`, or `Failed`.
  A task `blocked` with `startup_waiting` reads `Waiting at startup` and moves its row to
  `attention`: its Agent is running but waits at startup, usually on a first-run prompt only the
  user can answer. The badge does not reuse `Needs you`, which names the Bot Inbox column,
  because such a task need not have an Inbox item.
  A `failed` or `answer_unavailable` task moves its row to `failed`, since a task that never
  started often left no Session activity to group by.
  `Answered` means the Agent gave its final answer, not that Caxri Bot verified it.

The window lists only Caxri Bot's own Sessions by default: the Workbench already shows every
Session, and the user's hand-run Sessions mixed into this board buried the work Caxri Bot
dispatched. A `Caxri Bot` / `All` toggle above the board, each with its count, and the Command
Palette switch to every Session and back; the choice is remembered in the window's local storage
(`bot-board-store.ts`). In the `All` scope each Caxri Bot row leads its chip with
`Caxri Bot`. The Server's board, and `caxri bot board`, always cover every Session, so the
Caxri Bot itself still sees the whole Workbench.

The title bar's **Sessions** toggle, left of **Needs you**, collapses the board column so the
Terminal takes its width, for example to read the Terminal beside the Inbox in a medium-width
window: with the board open the Inbox becomes a drawer over the Terminal below 1080px, and with it
collapsed only below 720px. The column has a fixed width and no resize edge, so open or collapsed
is the only state, and it is remembered in the window's local storage (`bot-board-store.ts`).
A collapsed board stops polling until it opens again. Neither toggle has a keyboard shortcut of its
own; both are rows in the window's Command Palette.

Each row favors icons over words so the Project name keeps its width. The first line holds the
activity glyph (a live turn draws the PrimarySidebar's monochrome running arc in `--muted`, not a
green spinner, so the same Session reads the same in both windows and a board of busy Agents does
not turn into a wall of green), the Session title, Caxri Bot task's status icon, and the relative update time.
The second line holds the Agent's color icon, the Project name, an icon for a non-running process
(exited, failed, interrupted, starting, or suspended; a detached Terminal shows none), and the pull
request as `#N` with a checks icon (passed, failed, or pending). Every icon carries a tooltip and
an accessible name with the full wording: the task tooltip leads with its label (`Waiting at startup`,
`Taken back`, ...), explains the status, names the failure reason, and ends with the delegation ID;
the pull request tooltip reads `#N State · Checks: title`. A takeover uses a warning tint because it
means Caxri Bot has let the Session go: the user typed into it, and Caxri Bot no longer
drives it or sends it follow-ups.

The board never waits on GitHub. The window refetches the board, debounced, on every `state.changed`,
and polls it every 10 seconds while visible so cached pull request and CI state keeps moving even
when an event is missed. A `sessionPullRequests.changed` event does not refetch the board: the
window reads the `session.pullRequests` snapshot once per debounce window and patches only the rows
of the Sessions the event named (`refreshBotBoardPullRequests`). Every other row keeps its
object, so a new, merged, or unavailable pull request repaints one row rather than the whole board.
Caxri Bot window reads that snapshot itself because it does not mount the Workbench window's
query invalidation. Delegation receipts announce themselves rather than waiting for
that poll: creating a task, or changing its status or failure reason, sends a `state.changed` naming
the task's Session, because many of those transitions (a startup deadline, an asynchronous result
collection, a rejected follow-up) change no Session or Terminal record. Saves that only advance
bookkeeping stay silent, as does Server restart recovery: Desktop windows reload their state on
reconnect, and a later `status` or `wait` reads the recovered receipt directly.

### Completion notices

`BotCompletionNotifier` (`apps/server/src/domains/bot/completion-notice.ts`) pushes a
delegation's completion, failure, or need for input straight into Caxri Bot Terminal, so the
Caxri Bot no longer has to poll `agent delegate wait` in a loop to learn that a task it dispatched
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
  or the last input since then was a submitted line (a standalone Enter outside a bracketed paste,
  such as a mid-turn steer), which leaves no draft behind. A draft typed mid-turn, or typed into the
  Caxri Bot after it went idle, defers delivery instead of risking an unwanted Enter, and the
  `draft_input` deferral logs `inputsSinceTurnStart`, a keystroke count. The injected write itself
  never bumps this epoch;
- Caxri Bot's own Session has no pending permission prompt (`agentActivityState` is not
  `waiting`). Its unread flag is deliberately ignored: every settled Caxri Bot turn marks its own
  Session unread, and Caxri Bot window never marks it read.

On a Chat Caxri Bot the coalesced line is sent as a Chat message (`AgentChatService.send`), which
queues behind a running turn the way a typed message does; on a PTY it is pasted into the exact launch
as a bracketed paste, and Enter follows as its own write once the paste is acknowledged
(`completion-notice-delivery.ts`). Claude Code reads input arriving in one chunk as a paste and keeps
an Enter inside it as a new draft line, so a line and its Enter written together would sit unsent in
the composer of Caxri Bot on Claude Code. The idle-proof fence above applies to both.

Caxri Bot launched with nothing owed (for example by `bot.ensure` when the first Session is
handed over from the Workbench) carries no launch prompt and runs no first turn, so it has no
finished turn to prove idle. Its fresh launch counts as one idle point instead: a Chat Caxri Bot
proves it when its Chat reports ready with no prompt due, and a PTY Caxri Bot when the main thread's
first `sessionIdentified` (SessionStart) arrives with no input since the launch, or when eight seconds
pass with no signal at all (`promptless-launch.ts`). The timeout exists because Codex fires
SessionStart only as the first prompt goes in, and Claude Code in a Terminal binds no SessionStart
hook, so without it either Caxri Bot kept a hand-over notice until the user spoke first. Input or a
started turn before that point withdraws it.

A transition that arrives while any of these fails stays queued and is retried the next time the
Caxri Bot reaches a clean idle point; several transitions queued at once coalesce into one line. A
successful delivery also consumes the settled-turn identity it just proved idle against, so at most
one line is ever injected per proven-idle turn: the injected write never bumps the input epoch and
does not invalidate the idle proof, so without consuming that identity a second, closely timed
transition could otherwise reuse it and write a second time before Codex has actually started a fresh
turn to read the first line.

Delivery is deduplicated by delegation ID and the receipt revision that produced it, and is fenced to
Caxri Bot Terminal's current launch, so a Codex relaunch mid-flight cannot double-send: at most
one notice per settled transition, never two. The residual risk is the same in-flight-keystroke race
every exact-launch write already accepts (a keystroke sent in the same event-loop turn as the write,
before its epoch bump is observed).

Pending notices are stored in `bot_pending_notices`, one row per delegation, and a row is
deleted when its notice is consumed, so they survive a Codex relaunch and a Server restart. A
relaunched Caxri Bot has no finished turn to prove idle against, and waiting for the user to speak
first would leave it silent after every restart. Instead the launch resolves its first prompt
(`TerminalManagerOptions.agentLaunchPrompt`) from what is still owed: `[Caxri notice] The Agent
Caxri Bot restarted.`, the missed delegation updates, and whether a turn was cut off. That prompt is
built without consuming anything; the rows it carried are settled only once the launch reports
running (`onLaunched`), so this path is at least once rather than at most once: a crash between
spawn and that report repeats them on the next launch instead of losing them. Settlement removes
only the exact revisions the prompt reported, so a newer transition that lands before the launch
runs stays owed. A Chat Caxri Bot has no launch argv, so `AgentChatService`'s `onReady` hook sends
the same prompt as its first Chat message once the provider is ready, and settles it only after the
Chat accepted it.

The cut-off turn comes from an `interrupted_turn` row the notifier writes when a main-thread
Caxri Bot turn starts and deletes when that turn finishes or fails. A row still present at launch
means Caxri or Codex went away mid-turn, so the prompt tells Caxri Bot to continue that work.
`bot.stop` deletes it first: a deliberate stop must not resume on the next launch, though the
delegation updates it missed are still owed. A standalone Escape typed into Caxri Bot deletes it
too, because Codex ends an interrupted turn without a `Stop` hook and the user abandoned that work.
The Escape is taken at face value, like the coordinator's own interrupt handling; when it only
closed a picker, the turn's next main-thread tool or attention signal writes the row again, so a
turn that is really still running is still resumed after a restart.

A follow-up or resume refused at admission (`target_busy`, `target_not_ready`, and the other
rejections that fail a task straight out of `requested`) raises no notice: the refusal happens inside
the `agent delegate create` call Caxri Bot is still waiting on, so the CLI already returned it.

### Managed Session notices

Delegation notices only cover tasks Caxri Bot dispatched, so Caxri Bot used to learn nothing
when the user worked in a Session it manages, or when an Agent there finished, failed, or asked for
input outside such a task. Every activity transition of a managed Session (created or handed over,
see `caxriBotRows().sessionIds`) now reaches Caxri Bot too, through the same fenced line
as every other notice: `Session <id> is working`, `needs input`, `finished its turn`,
`failed its turn`, or `is idle`. The transition comes from the one choke point every durable
activity write passes (`hasSessionActivityChanged`, hooks and probes alike), and the line carries
only the Session ID and that closed state word.

These changes are batched rather than written one by one (`BotQueuedNotices`,
`apps/server/src/domains/bot/queued-notices.ts`), because one Agent turn alone produces
several transitions, and Caxri Bot, interrupted by each, would never finish its own turn:

- Only each Session's latest state is kept, so `is working` followed by `finished its turn` reaches
  Caxri Bot as the one that still holds.
- A batch settles once no managed Session changed for five seconds, and at the latest thirty seconds
  after its first change, so a Session that keeps flipping is still reported.
- A settled batch waits for Caxri Bot's next idle point like any notice, collecting later
  changes into the same line. An unsettled change rides along with any other notice that goes out
  first, and a relaunched Caxri Bot's launch prompt carries every change it missed.
- Skipped: Caxri Bot's own Session, Sessions outside the managed set, the `unknown` state (Caxri
  lost track of the Agent, which gives Caxri Bot nothing to act on), and a Session running a
  task Caxri Bot dispatched, plus ten seconds after that task settles. Its delegation notice
  already reports the task, and the Session's own transition lands moments before or after it.

The batch lives in memory only, like Inbox and hand-over events: after a restart Caxri Bot
reconciles current state with `bot board`, which its launch prompt asks it to do anyway.

## Bot Inbox

The Bot Inbox is what Caxri Bot explicitly raised for the owner: pull requests it
verified as ready to merge, and questions only the owner can answer. Caxri Bot window
shows it as the right-side "Needs you" column (toggled from the header, open-item count on the
toggle in the `--badge` tokens rather than the accent). The header names Caxri Bot's Project and
keeps the full workspace path in its tooltip. The reply target card takes the raised `--elevated`
fill, not an accent border, because it is a persistent selection rather than focus. It is never inferred from Terminal output or Session state: an item exists only because
Caxri Bot ran `bot inbox add`, so the owner can trust that everything there is waiting on
them, including after they were away from the computer.

**Notification.** When Caxri Bot adds a new open item, Desktop raises one system notification
("Caxri Bot needs your action", the item's title, or a count for a burst) unless Caxri Bot window
is focused or Agent notifications are off in Settings. Items already open at launch are the baseline
and never replayed. Clicking it opens Caxri Bot window with the Inbox shown. Main logs each
decision as `agent_notifications.decided` with `attentionKind: botInbox` and an `outcome` of
`shown`, `botFocused`, or `disabled`.

**Kinds.** `merge` names a pull request URL and the head commit (`--head`, the `headRefOid` the
Caxri Bot verified). `decision` is a product or scope choice, optionally with numbered `--option`s.
`hands` is a step that needs the owner physically, such as a login or a device. A card renders a
question's options as buttons: pressing one sends that option, exactly as written, as the reply,
and the composer stays the way to answer anything else. Questions sort
above pull requests, because a question blocks Caxri Bot while a ready pull request only waits.

**Storage.** Items and replies live in `bot_inbox_items` and `bot_inbox_replies`
(`apps/server/src/domains/db/schema/bot.ts`), owned by `BotInboxService`
(`apps/server/src/domains/bot/inbox.ts`). An open item is unique per `kind` and key: a
`merge` item is keyed by its pull request URL, so reporting the same pull request again replaces
the open item and bumps its `revision` instead of adding a second card. A question uses the
Caxri Bot's own `--key`. Closed items are pruned to the newest 50. Session and delegation IDs are
context only, without a foreign key, so an item outlives an archived Session.

**Merge.** The owner's Merge click sends the item `revision` it rendered. The Server refuses when
Caxri Bot replaced the report meanwhile, when the item is stale, or when a merge is already in
flight, then runs `gh pr merge --match-head-commit <verified head>` with the repository's preferred
method. GitHub therefore refuses if anything landed after Caxri Bot's verification. Pending or
failing checks do not disable Merge: branch protection decides that on the merge itself. From the
confirmation until the reply, the button reads `Merging…` and refuses a second press; an option
button is likewise disabled while its answer is in flight.

**GitHub reconcile.** Every 60 seconds, serially and single-flight to protect the shared `gh`
quota, the Server reads each open `merge` item's pull request. A head other than the verified one
marks the item stale (`headMoved`) until Caxri Bot reports the new head; a pull request merged
or closed elsewhere closes the item. The live view (checks, merge state, draft) is memory only. A
failed read keeps the item open with an unknown live state; it never closes it.

**Replies.** The reply box answers one item: the one picked with `@` (the picker lives in this box,
not in Caxri Bot Terminal, because Codex's composer already claims `@`), or the only open
question when there is exactly one. A reply is stored first, then announced through the completion
notifier as `[Caxri notice] ... inbox item <id> has a new reply.`, behind the same idle and draft
fences as task notices. Caxri Bot reads it with `bot inbox show` and acknowledges the
sequence with `bot inbox ack`; the card shows "Delivered to Caxri Bot" until then and "Read
by Caxri Bot" after. Because pending notices are memory only, every unacknowledged reply is
re-announced when the Server starts and whenever Caxri Bot process launches. Dismissing an
item, and an item merged or closed outside the Inbox, also notify Caxri Bot; its own `resolve`
does not.

**Authority.** Caxri Bot's Endpoint (`bot` capability) can `add`, `list`, `show`, `ack`,
and `resolve`. Only the owner's window can `reply`, `dismiss`, and `merge`: those are Desktop-owned
commands Caxri Bot window admits, and the CLI exposes none of them, so Caxri Bot can
never merge its own report.

**Mobile.** A paired phone with the `control` role opens the same list from a `Caxri Bot · N items need
you` row under the Project filters on its Sessions screen; the row appears only while items are open. It shows the open items, questions first, with Desktop's kind
labels, the pull request as `repo#number`, Caxri Bot's Markdown, numbered options, and the
owner's replies with the same read state. Reply on a card opens a composer; the reply is stored
with source `mobile` and reaches Caxri Bot exactly like a Desktop reply. Merge and Dismiss stay
on Desktop, and the phone has no Inbox notification. Bodies and older replies are shortened to fit
one mobile frame, and a `botInbox` subscription refreshes the screen live. Authorization and
wire details are in [mobile authorization](mobile/authorization.md#bot-inbox-from-mobile).

## Hand-over

The user can give Caxri Bot work that is already underway: Sessions they started themselves, and
Agent conversations begun outside Caxri. Before hand-over Caxri Bot could delegate only into
Sessions it created, so a half-finished task in the user's own Session had to be restated from
scratch.

**Picking.** Caxri Bot window's title bar **Hand Over** button opens a searchable, multi-select
dialog (`bot-handover-dialog.tsx`); so do the **Hand Over…** button in the empty board and
empty Inbox, and the Workbench command palette's **Hand Over to Caxri Bot…**
(`caxriBot.handOver`). A Workbench Session's context menu and the palette command open the
same dialog with that (selected) Session already checked, and both offer **Take Back from Agent
Caxri Bot** (`caxriBot.takeBack`) instead once Caxri Bot manages it.
The dialog has two tabs that share one selection and one optional note:

- **Sessions** lists every Workbench Session Caxri Bot does not manage yet, grouped by Project,
  newest first. A group checkbox selects the whole Project.
- **Outside Caxri** lists Claude Code, Codex, and Grok Build conversations found in the providers'
  own history folders (`apps/server/src/domains/agents/external-conversations.ts`): the last 30
  days, at most 200, excluding any conversation a Caxri Terminal already binds. Discovery reads those
  folders, so it runs only once the tab opens. Each conversation is grouped under the visible Project
  whose root contains its working directory; one in no Project is grouped under its folder, which
  hand-over adds as a new Project. A conversation that may still be open elsewhere is marked,
  because resuming it in Caxri would fork it. For Codex the evidence is a machine-wide open-file
  probe (`apps/server/src/domains/agents/providers/codex/open-sessions.ts`): a Codex process keeps
  its rollout open for the whole conversation, even while idle, so the mark covers a conversation
  untouched for hours. When that probe fails, and always for Claude Code and Grok Build, which
  expose no open-conversation signal, a transcript written in the last two minutes is the mark.

Search narrows what the list shows, never what stays selected. `bot.session.handOver` handles
every entry on its own, so a refused entry (for example an archived Session, or a conversation that
disappeared) never blocks the rest. While the dialog is open it reports a partly or wholly refused
request in place: refused rows stay selected where they were, each with its reason, and no toast
repeats it. A full success closes the dialog and the toast counts what was accepted; so does any
answer that arrives after the user closed the dialog. From the Workbench the request first runs `bot.ensure`, so handing over works
before the user ever opened Caxri Bot. `caxri bot session hand-over` and `take-back` are
the human CLI equivalents. No Agent can hand over or take back, or list outside conversations:
Server Core accepts `bot.session.handOver`, `bot.session.takeBack`, and
`bot.conversations` only from the Desktop and the human CLI, so even an Agent Endpoint holding
an `agent:control` grant (and with it `agents.control`) is refused.

**What hand-over records.** An accepted entry joins Caxri Bot's ownership set, opens a ledger task
carrying the user's note, and stores one hand-over record (`app_state` key `botHandovers`,
`apps/server/src/domains/bot/handover-records.ts`). An outside conversation first becomes a
new Session holding a parked Agent Terminal bound to that conversation; nothing launches until the
Session is opened or Caxri Bot continues it. The record is `continuable` when the Session's
Agent has a provider conversation Caxri Bot can resume, whether that Agent runs in a PTY or as an
[Agent Chat](agent-chat.md), otherwise `ownership_only` with a closed reason (`agent_missing`,
`provider_session_missing`, `provider_unsupported`, or `chat_surface` for a Chat whose provider
cannot correlate a Caxri Bot task, today Grok Build); Caxri Bot may still start new work there.
Records stored before Chats became continuable also carry `chat_surface`. The board marks the row with a hand icon until the first
task continues it.

**First continuation.** Caxri Bot learns about a hand-over through the same content-free notice
queue as delegation completions (see [Completion notices](#completion-notices)), with the hand-over
ID. Its first task there is
`agent delegate create --session <id> --prompt-file <path> --continue-handover <handover-id>`, which
continues that exact conversation instead of starting a fresh Agent, and consumes the record (see
[Agent delegation](agent-delegation.md#follow-up-stop-and-recovery)). While the Agent is in a turn
the request is refused; a hand-over of a busy Agent is announced as `ready` once that turn ends.
Notices Caxri Bot lost to a restart are queued again on its next launch.

**Take-back.** Typing into a handed-over Agent Terminal, or sending its Chat a message, command,
rewind, interrupt, Send Now, or a queue Resume that releases queued messages from any Client, takes
the Session back at once (a Chat draft does not): the user is working there
again, and Caxri Bot must not take the conversation over afterwards. Input the Chat receives
from delegation, dispatch, or Caxri Bot notices does not. The
Session's menu and `bot session take-back` do the same explicitly. Taking back never stops an
Agent; tasks Caxri Bot already started keep their receipts.

Because a single keystroke ends the hand-over, the Workbench says so before and after. Every Session
Caxri Bot manages shows a small hand marker in the sidebar row
(`caxri-bot/bot-session-marker.tsx`); for a hand-over that continues an Agent
conversation its label adds that typing there takes it back, or for a Chat that sending a message or
stopping there does. When typing does take one back, the
main window shows an info toast naming the Session. Both read `bot.managedSessions`, which
returns the managed IDs, the subset where input takes the Session back (and which of those are
Chats), and the most recent
input-caused take-backs (in Server Core memory, at most 16). The notice rides on that read instead
of a dedicated event: every take-back already announces a full `state.changed`, after which the
marker must re-read the set anyway, so one read serves both without adding an event to the
registry, the durable journal, mobile subscriptions, and the companion-window policy. A reader
treats the take-backs it sees on its first read as already shown.

## Caxri Bot's Agent

Caxri Bot runs on Codex or Claude Code (`botAgentIds`). The title bar's Agent chip names
the current one and opens a menu to switch; the Command Palette offers the same switch. Switching is
not destructive, so it takes the in-app confirmation, which says that only the conversation starts
over. `bot.switchAgent` stores the choice in the `app_state.botAgent` cell, then replaces
Caxri Bot Terminal's provider in place (`terminalSurfaces.replaceAgentProvider`) and relaunches
it fresh through the Workbench's own `terminal.restart`. The Terminal row, and so Caxri Bot
identity, stays: every task it delegated before the switch is still its own, and its task ledger,
memory, Inbox, and Caxri Bot Sessions carry over because they live in Caxri and the workspace, not
in the conversation. Without a Caxri Bot Terminal yet, the choice is stored and the next
`bot.ensure` uses it.

Both Agents read the same generated `AGENTS.md`: Codex natively, and Claude Code because it loads
`AGENTS.md` when no `CLAUDE.md` exists, which the workspace never has.

Claude Code asks whether to trust a new folder even when it runs without permission prompts, and
only its own config can answer that. Before every Claude Code launch of Caxri Bot,
`grantClaudeFolderTrust` (`apps/server/src/domains/agents/providers/claude/folder-trust.ts`) marks
the workspace, and its real path, trusted in Claude Code's global config (`.claude.json` under
`CLAUDE_CONFIG_DIR`, or in the home directory), under the same `.lock` directory Claude Code takes, so
a running Claude Code never loses a write. That lock sits beside the config path as looked up, even
when the config is a link into a dotfiles folder; the write goes through the link to its target. It changes only the workspace's own `projects` entry. It
never creates the config: a Claude Code that never ran shows its onboarding anyway, and its first run
must not find a file Caxri invented. The outcome is a closed enum logged as
`caxri_bot.claude_trust_prepared`; anything but `granted` or `already_trusted` leaves Claude
Code's own trust question for the user. A task delegated to Claude Code gets the same
grant for its launch directory (`claudeTrustPreparer` in the dispatch domain, after the directory is validated against
the Session's authorized roots; Chat children skip it), logged as `agent_dispatch.claude_trust_prepared`. When that
grant fails, the task still stops at Claude Code's question and its delegation reports `blocked` with
`startup_waiting` for Caxri Bot to raise in the Inbox.

Automatic Session naming skips Caxri Bot's own Session (`SessionAutoNamingService`). That Session
carries every task in turn, so a name taken from one request would mislabel the next, and Claude Code
would show it on Caxri Bot's composer once the native `/rename` wrote it into the conversation.

## Clear Caxri Bot Data

**Clear Caxri Bot Data…** (More menu or Command Palette) works like a browser's Clear Browsing
Data: one dialog lists what Caxri Bot keeps, each with its size from `bot.data`, and the
user ticks what to forget. Only Caxri Bot-owned data is offered; Sessions, their Terminals, and the
user's repositories are never touched.

| Option       | What it clears                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks        | Ledger rows: the finished ones (the default), all of them, or ones chosen from the list. Delegated Sessions stay; a hand-over Caxri Bot has not continued goes with its task, since its note lived there. |
| Task files   | The briefs in `tasks/` and the pull request reports in `reports/`. A link there is removed, never followed.                                                                                               |
| Needs you    | Every Bot Inbox item, open or closed, with its replies.                                                                                                                                                   |
| Memory       | `memory/*.md` back to their templates. Offered only once a file differs from its template; implies Instructions.                                                                                          |
| Instructions | Rewrites `AGENTS.md` from the current template and the memory that remains.                                                                                                                               |
| Conversation | Relaunches Caxri Bot fresh on a new conversation, ending the current turn.                                                                                                                                |

The dialog opens with only the finished tasks ticked, and with nothing ticked when no task has finished. When memory or instructions change while the
running conversation already read them, it warns that Caxri Bot still knows them until the
conversation starts over. The window asks Desktop Main (`caxriBot.clearData`), which shows the
native destructive confirmation listing each ticked item before it forwards the internal
`bot.clearData`; a cancel keeps the dialog and its selection. On success the dialog closes and
a notification names what went. Server Core logs `caxri_bot.data_cleared` with counts and
flags only. A clear queued behind a Caxri Bot Agent switch can wait for that relaunch, so its request never
expires on the client. A failure partway still refreshes the window when tasks already went or the
conversation restart was reached, and the log names the stage that failed.

## Observability

Every step of a Caxri Bot workflow leaves a content-free log line in Server Core's
`<userData>/logs/server-core.jsonl`, readable with `caxri logs query` (see [CLI](cli.md)). Together
they reconstruct a bug report without Terminal output or transcripts:

| Event                                         | Meaning                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ipc.request`                                 | Every CLI call Caxri Bot makes (`bot.board`, `agent.delegation.*`), with its duration and correlation ID (debug level).                                |
| `caxri_bot.ensured`                           | `bot.ensure` finished: `outcome` `created`, `restored`, or `running`, the prior Terminal state, and the duration.                                      |
| `caxri_bot.stopped`                           | `bot.stop` parked Caxri Bot (`stopped`) or found nothing running (`not_running`).                                                                      |
| `caxri_bot.session_created`/`_discarded`      | A Caxri Bot Session was created, or removed because its delegation was refused before launch.                                                          |
| `agent_delegation.requested`                  | A task was admitted: `mode` (`new`, `follow_up`, `resume`), whether Caxri Bot sent it, its Session, and its parent task.                               |
| `agent_delegation.transitioned`               | Every receipt `status`/`failure` change, with the previous status, the task's age, and whether it came from restart recovery.                          |
| `agent_delegation.admission_rejected`         | Why a follow-up or resume was refused, as a closed reason.                                                                                             |
| `caxri_bot.completion_notice_queued`          | A settled task, Inbox or hand-over event, or managed Session state (`sessionState`) was queued for Caxri Bot, with the batch size (debug).             |
| `caxri_bot.completion_notice_deferred`        | Which gate holds the batch back (`bot_busy`, `draft_input`, `awaiting_permission`, ...), once per change (debug).                                      |
| `caxri_bot.completion_notice_delivered`       | The coalesced line was written, with its entry count per kind (`sessionCount` for Session states), the oldest entry's wait, and the blocked turns.     |
| `caxri_bot.fresh_launch_ready`                | Caxri Bot launched with no prompt became able to take a notice: `reason` (`session_started`, `start_timeout`) and `waitMs` since the launch.           |
| `caxri_bot.resume_prompt_delivered`           | Relaunched Caxri Bot received its launch prompt: missed delegation `count`, Inbox `inboxCount`, `interruptedTurn`, and the oldest entry's `waitMs`.    |
| `caxri_bot.task_recorded`                     | A ledger task was created, with `origin` `bot` (`bot task add`) or `delegation` (an unregistered dispatch).                                            |
| `caxri_bot.task_transitioned`                 | A ledger task changed status: `from`, `to`, and the task's age.                                                                                        |
| `caxri_bot.inbox_item_reported`               | Caxri Bot added an Inbox item or replaced the open one with the same key: `kind` and `outcome` (`added`, `updated`).                                   |
| `caxri_bot.inbox_item_closed`                 | An item closed: the closed `reason`, its `kind`, how long it was open (`openMs`), and its reply count.                                                 |
| `caxri_bot.inbox_replied`                     | The owner replied: item `kind`, reply `sequence`, and `source` (`desktop`, `mobile`); never the text.                                                  |
| `caxri_bot.inbox_stale_changed`               | A `merge` item went stale (`headMoved`) or became current again (`null`).                                                                              |
| `caxri_bot.inbox_pull_request_refresh_failed` | Reading one `merge` item's pull request failed, with the shared CLI failure `kind`.                                                                    |
| `caxri_bot.codex_open_probe_failed`           | The Outside Caxri Codex open-file probe failed and Codex rows fell back to mtime: closed `reason` and `durationMs`.                                    |
| `caxri_bot.agent_switched`                    | `bot.switchAgent` finished: `outcome` (`switched`, `unchanged`, `stored`), `from`, `to`, and the duration.                                             |
| `caxri_bot.claude_trust_prepared`             | A Caxri Bot launch on Claude Code pre-granted workspace trust: the closed trust `outcome` (warn unless `granted` or `already_trusted`).                |
| `caxri_bot.data_cleared`                      | Clear Caxri Bot Data finished: `outcome` (`cleared`, or `failed` with `failedStage` and `tasksDeleted`), counts, flags, `taskScope`, and the duration. |

The delegation ID links them: Caxri Bot's `agent delegate create` returns it, every transition
and notice names it, and the `ipc.request` line of each `agent.delegation.*` call carries it as
`fields.delegationId`.

`caxri diagnostics snapshot` summarizes the same state in its `caxriBot` section, so one
command attaches it to a bug report: Caxri Bot run `state`, its Terminal ID with the Shell and
Agent process states, the number of Caxri Bot Sessions, the 20 most recently updated tasks in those
Sessions (`delegationId`, `status`, `failure`, `correlationFailure`, provider, whether the
Caxri Bot sent it, and the time from admission to the latest transition), and completion notice
delivery (batch and delivered notice counts, average and maximum `waitMs`,
`rejected`/`unconfirmed` failures, launch prompts with the notices they carried, and the delegation
notices still pending in the database). Task fields are IDs, enums, and timestamps only, never the prompt, answer, or launch
input. Notice latency is aggregated from the retained `caxri_bot.completion_notice_*` log
lines, so it covers only what log rotation still keeps; the snapshot does not measure how long a
notice waits before it is queued.

## How Caxri Bot works

The generated `AGENTS.md` (`BOT_INSTRUCTIONS` in
`apps/server/src/domains/bot/workspace.ts`) is Caxri Bot's whole operating manual. It is
rewritten on every `bot.ensure`, so an upgrade replaces it. What Caxri Bot has to keep
lives elsewhere: tasks in the durable task ledger, what it learned in `memory/`, and one task file
per delegation in `tasks/`.

### Task ledger

The ledger is the `bot_tasks` table, read and written through `bot task add|update|list`
(`BotTaskLedger`, `apps/server/src/domains/bot/tasks.ts`). It replaced a hand-kept
`ledger.md`, which existed only while Caxri Bot remembered to write it. A task has a title, a
status (`pending`, `dispatched`, `waiting_user`, `done`, `dropped`), and optional Project, Session,
root delegation, one-line note, and pull request URL. The open tasks also appear on
`bot board`.

The ledger does not depend on Caxri Bot's diligence. The first receipt of a root delegation the
Caxri Bot sends records a `dispatched` task on its own, titled after the Session Caxri Bot
named. When Caxri Bot then links that delegation to the task it registered at intake
(`bot task update <id> --delegation <id>`), the automatic row merges into it in one
transaction. Follow-ups and resumes resolve to their chain's root delegation, so one task follows a
request through every continuation. At most 500 tasks may be open; closing finished ones frees room.
An older workspace's `ledger.md` is imported once by Caxri Bot itself, as its instructions
direct.

### Memory and choosing the repository

`memory/repositories.md`, `memory/preferences.md`, and `memory/lessons.md` in the workspace are the
Caxri Bot's long-term memory and the user's way to teach it. `bot.ensure` seeds each one with a
short template only when it is missing, never overwrites it, and embeds all three after the
instructions in the generated `AGENTS.md`, so they reach every new conversation. The embedded copy is
capped at 40 KiB, cut at a line boundary with a note to read the rest, and Caxri Bot launches
with `-c project_doc_max_bytes=65536` (on both surfaces: a Chat Caxri Bot carries it as a
`codex app-server` root option) because Codex's default 32 KiB limit would otherwise drop the
memory silently. Caxri Bot on Claude Code reads the same `AGENTS.md`. The files live in
`<userData>/caxri-bot/memory/`; the user can edit them
directly or tell Caxri Bot what to remember.

The instructions make repository choice evidence-based: `memory/repositories.md` first, then each
candidate Project's `README` and `AGENTS.md`, and a question to the user only when two stay equally
plausible. A repository missing from the board is reported, never substituted with a related
Project. Every dispatch reply names its target on its own line, and a correction is recorded in
memory before the task is redispatched.

- **Intake.** Requests are expected to be short: an issue link, a screenshot, or a one-line symptom,
  and most of them bug fixes. Caxri Bot reads linked issues itself and writes down everything a
  screenshot shows, because the delegated Agent starts with no context.
- **Dispatch.** Each task gets its own Caxri Bot Session and task file. The task tells the Agent to
  follow the target repository's own `AGENTS.md` and delivery flow, work on its own branch, deliver a
  pull request with green checks, and not merge, release, or deploy unless the user asked.
- **Resuming itself.** A relaunched Caxri Bot gets the restart notice described under "Completion
  notices" as its first prompt, reconciles with `bot task list` and `bot board`, and
  continues an interrupted turn unless the user stopped it.
- **Continuing after a restart.** A follow-up reaches only a running Agent. When one fails with
  `target_changed` or `target_not_ready` because the Agent exited or Caxri restarted, Caxri Bot
  sends the same prompt with `--resume`, which relaunches the Agent on the same conversation. A task
  the user typed into is theirs and is not continued.
- **Bug reports.** A bug task must reproduce first and finish with the reproduction, the root cause
  with file references, the fix, evidence (a test, measurements, or screenshots), and the blast
  radius. When a report lacks reproduction or evidence, Caxri Bot sends a follow-up before it
  calls the pull request ready.
- **Escalation.** Caxri Bot asks the user only about product or scope choices, table
  definitions and large features, destructive or credential-bearing operations, genuinely ambiguous
  requests, and steps that need the user's hands. It decides routine questions itself and answers
  the delegated Agents' routine questions with follow-ups.
- **Reporting.** It speaks only when something completes, needs the user, or fails. Each ready pull
  request is reported with the bug, cause, fix, evidence and the commit it was gathered on, and risk,
  so the user can decide to merge in under a minute. Before calling one ready, Caxri Bot reads it
  live with `gh pr view`, because the board's copy is cached and has no head commit: it must be
  `MERGEABLE`, every check must have passed, and its `headRefOid` must be the commit the delegated
  Agent verified. A moved head gets one re-verification follow-up; a head that keeps moving is
  reported as not ready rather than chased. A ready pull request is reported as a `merge` item in the
  [Bot Inbox](#bot-inbox), with the full report in the item body; a question for the
  user becomes a `decision` or `hands` item, and Caxri Bot checks `bot inbox list` at the
  start of each turn for replies.
- **Boundaries.** Caxri Bot works only through the Caxri CLI and read-only tools. It never
  edits the user's repositories, reads Caxri's own profile, or operates the user's screen.

## Authority

When domain services launch Caxri Bot Terminal, they begin its Agent Endpoint with
`role: 'bot'`. That role adds two fixed capabilities: `bot` and `agents.delegate`. Its
Project scope stays Caxri Bot's own system Project, so `agent:control`, dispatch, steer, and
Settings writes are never implied.

- `bot.board` requires `bot`.
- `bot.task.create`, `bot.task.update`, and `bot.task.list` require `bot`.
  A task may name only a visible Project, and may link only a delegation Caxri Bot sent.
- `bot.session.create` requires `bot`. It creates an empty Session in a visible
  top-level Project without changing the Workbench selection, and records the Session as a
  Caxri Bot Session. Once Caxri Bot owns 1,000 existing Sessions it refuses with `CAPACITY`
  rather than disowning the oldest, which may still run a task; deleting Sessions frees room.
- `bot.session.archive` requires `bot`. It archives one Caxri Bot Session through the
  same `session.archive` path as the sidebar: its Terminals and Chats are parked, and the user can
  restore it from Archived Sessions. Any other Session, including the user's own and the
  Caxri Bot's hidden one, is refused with `NOT_FOUND`, because Caxri Bot has no control
  authority over Sessions it did not create. A Session the user handed over is refused the same
  way even while Caxri Bot manages it: hand-over writes the same ownership list, but the
  Session stays the user's, so `requireBotSession` also rejects any Session with a hand-over
  record. Archiving does not remove the Session from the
  Caxri Bot's record, so a restored Session can receive delegations again.
- `agent.delegation.create` and `agent.delegation.presets` skip Server Core's Project-scope check
  only for a `bot` Agent principal. The delegation domain then admits the request only when
  all of these hold:
  - the caller is the exact recorded Caxri Bot Terminal in Caxri Bot Project;
  - the target is a non-archived Caxri Bot Session;
  - that Session is in a visible top-level Project.

  A busy user Session is refused, because a delegated pane would split its active layout.

- A delegation whose caller is outside the target Session fills that Session's empty pane, the same
  way an external delegation caller does. It uses the target's working directory, not the
  Caxri Bot's.
- Ownership stays with Caxri Bot Terminal. A Caxri restart or Codex relaunch starts a new
  Endpoint generation of that same Terminal, and status, result, wait, stop, and follow-up keep
  working for every task it delegated earlier. Any other Agent's tasks stay fenced to the exact
  generation that created them.

The human CLI owner also holds `bot`, so an operator can read the board or create or archive a
Caxri Bot Session from a shell.

## CLI

```bash
caxri bot board --json
caxri bot task add --title <title> --project <project-id> --json
caxri bot task update <task-id> --delegation <delegation-id> --json
caxri bot task list --all --json
caxri agent delegate create --project <project-id> --new-session --title <title> --prompt-file task.md --provider codex --json
caxri agent delegate create --project <project-id> --session <session-id> --prompt-file task.md --resume <delegation-id> --json
caxri bot session create --project <project-id> --json
caxri bot session archive <session-id> --json
```

`--new-session` is Caxri Bot's normal way to dispatch. It creates Caxri Bot Session inside
the same request that launches its Agent (`AgentDelegationService.create`), so the Workbench first
sees the Session with its Agent Terminal already in it. Before it, Caxri Bot ran
`bot session create` and then `agent delegate create --session` as two tool calls, and the
Session sat empty for as long as Caxri Bot took to write the second one. Any Agent may pass it
(see [Start work in a new Session](agent-delegation.md#start-work-in-a-new-session)); only the
Caxri Bot's Session is recorded as Caxri Bot's. A retry of the same request reuses the Session its first attempt
created, and a request refused before any task was recorded removes that empty Session again
(metadata only). `--new-session` requires `--title`, which becomes the Session's manual title. The
delegated Agent's first message is only a pointer to the private task file, so automatic naming used
to see nothing but "read the delegated task" and gave every Caxri Bot Session the same name; the
Caxri Bot wrote the task and is the caller that knows its subject. `bot session create` still exists for a Session Caxri Bot wants to prepare
without a task.

Inside Caxri Bot Terminal, Caxri Bot calls the version-matched CLI through
`"$CAXRI_CLI"` using its Endpoint credentials. That launcher (`<userData>/bin/caxri`, rewritten by
every Server Core start) runs the CLI bundle on the Server's own runtime, so an SSH Host without
`node` on `PATH` works the same as a local Host. A human owner is asked to confirm
`bot session create` and `bot session archive`; Caxri Bot's own call needs no
confirmation. See [CLI](cli.md) and
[Agent delegation](agent-delegation.md).

## Known limits and follow-ups

- Caxri Bot identity lives in an `app_state` cell rather than a Project column, by decision.
  `caxriBotRows` (`apps/server/src/domains/db/bot-rows.ts`) checks that the Project,
  Session, and Terminal still belong together, every Workbench list excludes the stored Project ID,
  and `bot.ensure` rebuilds a missing record. A `projects` role column would add a migration
  without fixing a known defect. Revisit it when a second kind of system Project appears or a real
  integrity defect does.
- Stopping Caxri Bot ends its current turn. Reopening resumes the conversation, not the turn;
  only a turn that a restart or crash cut off is continued.
- There is no setting to stop Caxri Bot whenever its window closes. The status bar chip and the
  explicit Stop cover the single-maintainer workflow; add one only when a real need appears.
- Caxri Bot runs with the user's own Codex or Claude Code configuration, including its sandbox
  and permission mode. Endpoint
  capabilities are product authorization, not a filesystem sandbox for processes of the same OS
  user.
- Caxri Bot delegates only into Sessions it manages: ones it created, normally with
  `--new-session`, and ones the user [handed over](#hand-over). It cannot queue work into any other
  Session of the user's.
- Memory edits reach Caxri Bot's embedded copy only on the next `bot.ensure`. Within a
  running conversation Caxri Bot knows its own edits, and reads the files again when the user
  says they changed them.
- The launch prompt is at least once: a Server crash between Caxri Bot's spawn and its running
  report repeats the same restart notice on the next launch.
- The cut-off turn marker clears only on `turnFinished`, `turnFailed`, or `bot.stop`. A turn
  the user interrupted inside Codex that reports neither is still described as cut off after a
  restart; the prompt asks Caxri Bot to continue unless the user stopped it on purpose.

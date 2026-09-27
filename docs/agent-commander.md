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

The window runs with the Desktop principal. Main therefore authorizes it separately, through
`AgentCommanderRendererPolicy` (`agent-commander-policy.ts`) in the `caxri:request` IPC path:

- **Always admitted.** A short read list (`commander.board`, Settings, keybindings, theme,
  `events.recover`), the Commander's own lifecycle (`commander.ensure`, `commander.snapshot`),
  `external.open`, and one Workbench hand-off, `agentCommander.revealSession`. `app.bootstrap` and
  `app.records` are refused: the window reads its rows only through `commander.snapshot`.
- **Terminal requests** (attach, detach, input, resize, restart, long paste, and the pane's
  reference-context read) are admitted only when they name the Commander Terminal, and
  `session.updateState` (the pane's own layout and focus) only when it names the Commander Session.
  Main learns both IDs from the reply to `commander.ensure` or `commander.snapshot`.
- **Everything else** is refused with `FORBIDDEN` and logged. That includes file edits, Project and
  Session mutations, Settings writes, and any other Session's Terminal.

Main routes events through the same policy:

- **Durable journal envelopes** (anything with a `cursor`) reach both windows, so each window's
  recovering event client sees a gap-free cursor sequence.
- **Terminal-scoped transient events** (`terminal.output`, `terminal.outputRecovery`,
  `terminal.sizeOwnership`) go only to the window viewing that Terminal.
- **Other transient events** go only to the Workbench, including `command.execute` and
  `desktop.openRequested`, so a menu accelerator never runs twice.

Each window tracks its own events-ready state.

Closing or reloading the Commander window detaches its view of the Commander Terminal, but the PTY
keeps running and the next window re-attaches from a snapshot. Closing the main window detaches
every Terminal view, the Commander's included, and then closes the Commander window.

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
and its CLI commands. It then creates any missing Commander row. The Terminal is launched only when
it was just created. An existing Terminal that an app restart or suspension interrupted is resumed
through a dedicated restore supervisor: the Workbench resumes Terminals only for the Session it
selects, and it never selects the Commander Session. A Terminal that exited on its own stays as it
is; the pane's own Resume and Restart actions relaunch it.

The board (`commander.board`) projects every non-archived Session in a visible top-level Project
into one of six groups, in this order: `attention`, `working`, `waiting`, `failed`, `finished`, and
`idle`. Each row carries:

- the primary Agent's process state;
- the cached pull request from the `session.pullRequests` snapshot, with the snapshot's
  `pullRequestsRefreshedAt`;
- whether the Commander created the Session.

The board never waits on GitHub.

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
  request is reported with the bug, cause, fix, evidence, and risk, so the user can decide to merge
  in under a minute.
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
  Commander Session.
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

- Commander identity lives in an `app_state` cell rather than a Project column. A durable
  `projects` role column was deferred because it changes the table definition.
- The board uses the cached pull-request snapshot and does not refresh pull requests row by row.
- The Commander Terminal keeps running after its window closes. It is visible again the next time
  the window opens.
- The Commander runs with the user's own Codex configuration, including its sandbox mode. Endpoint
  capabilities are product authorization, not a filesystem sandbox for processes of the same OS
  user.
- The Commander delegates only into empty Sessions it created. It cannot yet queue work into an
  existing Session, and it does not own a persistent to-do queue.
- Completion is not pushed to the Commander. It learns about finished tasks by waiting on all of
  its open tasks at once (`agent delegate wait <id> <id>...`) or by reading the board at the start
  of each turn.
- A delegated Codex that stops at a first-run prompt, such as folder trust for a directory the
  user's Codex configuration does not trust, fails with `startup_not_ready`. The Commander is told to
  name that Session for the user instead of retrying blindly.
- A development profile lives inside the primary checkout's `.git` directory, so Codex treats the
  Caxri repository as the Commander workspace's project and runs its repository hooks, which fail
  there. A packaged profile is not inside a repository and is unaffected.

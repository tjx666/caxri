---
kind: living
status: current
---

# Background Agent suspension

A Session left in the background keeps its Agent CLIs resident: every one holds a PTY, a process
tree, and the provider's in-memory conversation. Suspension parks the ones nobody is using and
brings them back when the user returns, so a workspace with many Sessions stops paying for idle
Agents without losing any conversation.

A suspended Agent Terminal keeps its tab, its record, its final screen, and its bound Agent
session id. Only the process is gone. When its Session is selected again, the ordinary
interrupted-restore path relaunches it with the provider's resume arguments (`claude --resume`,
`codex resume`, and so on); there is nothing to click.

## Settings

Settings › Agents has three rows. Their keys keep the `terminal.` prefix so values already written
to `settings.jsonc` still apply, but the rows sit with the Agents because they decide when an Agent
is suspended:

| Setting                                                                     | Default    | Range     |
| --------------------------------------------------------------------------- | ---------- | --------- |
| `terminal.suspendUntouchedAgents`: Suspend Agents you opened but never used | on         | on / off  |
| `terminal.idleSuspension.enabled`: Suspend idle Agents in the background    | off        | on / off  |
| `terminal.idleSuspension.afterMinutes`: Suspend idle Agents after           | 30 minutes | 1 to 1440 |

The idle window applies only while idle suspension is on. Both rules are evaluated by one Server
Core sweep every 15 seconds, so a park lands at most one sweep after its window elapses.

## Which Agents are eligible

Both automatic rules consider a Terminal only when every condition holds:

- It is a PTY Agent Terminal (never a Shell tab and never a Chat) whose provider supports automatic
  suspension (Claude Code and Codex; Grok Build does not), its process is running, and its Agent is
  `starting` or `running`.
- Its Session is not the selected Session, not the Agent Commander's Session, and not archived.
- No phone has it open through the mobile gateway: neither its Terminal screen nor its Session's
  Conversation.
- The Agent is not mid-turn, and it is not waiting for the user: a permission prompt or a question
  (`attentionRequested`) holds it until the coordinator accepts the matching resolution
  (`attentionResolved` or Claude's `toolBatchFinished`) or the main turn starts or ends again.
- For the Session's Primary Agent, the Session's activity state is not `running` or `waiting`.

A turn ends only when the coordinator applies its completion, not when the raw `Stop` hook arrives:
the coordinator defers a parent's completion while its background subagents still run, and it
reconciles a completion whose hook was lost. A subagent's own turn signals (`agentId` set, such as
Claude's `SubagentStop`) count as activity but never end the parent's turn. A standalone Escape
typed into the Agent is the user interrupting it; it ends the turn and any pending prompt, because
Claude sends no completion hook for an interrupted turn.

The Escape is taken at face value, so one the TUI consumed for something else (closing a completion
menu) also ends the turn. The next main-turn signal that only arrives from inside a running turn
(a shell tool starting, finishing, or failing, Claude's `toolBatchFinished`, or an attention request
or resolution) reopens it, so a long command started after that Escape keeps the Agent awake. Until
such a signal arrives, only the idle window protects the Agent. That gap is deliberate: an Escape
followed by no hook at all looks the same as a real interrupt, which must still release the Agent.

An unread completion does not block suspension. The final screen is captured before the process
stops, so the output the user has not read yet is still on the tab when they come back.

### Untouched rule

An Agent that received no input and started no turn since this Server Core observed its launch is
parked 30 seconds after its Session is left (and at least 30 seconds after launch). This catches
Agents restored or created only to be glanced at.

### Idle rule

An Agent is parked once both of these are at least the configured window old:

- the time its Session was left, and
- its last activity: the launch, the latest Core-delivered input, or the latest accepted lifecycle
  signal of any phase. A launch older than the running Server Core counts as active since that
  Server Core started.

Returning to the Session resets the first clock; typing or any new turn resets the second.
Terminal output alone does not count as activity: an Agent is idle by its lifecycle state, not by
silence.

## Resume

Selecting the Session relaunches every `suspended` Terminal in it through the shared restore
budget. A Terminal on screen waits for its pane's grid before its PTY starts. If the conversation
cannot be resumed because it was never written to disk, the Terminal starts a fresh Agent session
instead and logs `terminal.resume_skipped`.

While a Terminal is suspended, the PrimarySidebar's Session hover card reads `Suspended` in the
neutral tone (not the idle state it last probed) and says the Agent resumes when the Session is
opened, naming Settings > Agents. The Terminal's recovery row reads `Suspended in the background,
resuming`, and its tooltip names the same setting. Neither claims the idle rule caused the park,
because the record does not say whether the idle rule, an archive, or a Process Explorer stop
parked it.

## Logging

Both transitions are logged without any Terminal or transcript content:

- `terminal.suspended`: the closed `reason` (`idle`, `untouched`, `archived`, `detached`,
  `requested`, `terminated`), the provider, and for the automatic reasons `idleMs` (since the last
  activity) and `backgroundMs` (since the Session was left).
- `terminal.resumed`: the Agent launch that brought back a parked Terminal, with the original
  `reason`, the provider, and `suspendedForMs`. The park time and reason are kept in memory only,
  so an Agent an earlier Server Core left `suspended` or `detached` resumes with
  `reason: beforeRestart` and `suspendedForMs: null`; the count stays complete across restarts, only
  the duration is unknown.

## Code

- `apps/server/src/domains/terminal/suspension-policy.ts`: the pure decision.
- `apps/server/src/domains/terminal/suspension.ts`: the sweep, the activity samples, parking, and
  the transition logs.
- `apps/server/src/domains/terminal/restore.ts`: the resume on Session selection.

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

- It is a PTY Agent Terminal (never a Shell tab) whose provider supports automatic suspension
  (Claude Code and Codex; Grok Build does not), or an Agent Chat on any provider; its process is
  running, and its Agent is `starting` or `running`.
- Its Session is not shown by any visible window (see [Open Sessions](open-sessions.md)), not Caxri Bot's Session, and not archived.
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

A hook can also lag the Escape: a provider's `PostToolBatch` or `PostToolUse` runs through a bridge
process and a socket, while the Escape travels Core's input channel directly, so Core may see the
Escape first and the interrupted turn's own last hook second. A real interrupt sends no `Stop`, so
reopening on that straggler would hold the Agent awake forever. A main-turn mid-turn signal that
arrives within 2 seconds after the interrupt (`LATE_MID_TURN_SIGNAL_WINDOW_MS` in
`lifecycle-watchdogs.ts`, shared with Caxri Bot completion notifier) therefore does not reopen
the turn; the same signal after the window still does. An Agent Endpoint `SIGINT` takes the same
path as the Escape: it clears the in-flight marker (and Caxri Bot's `interrupted_turn` mark) and
starts the same window. The 2 second value is an estimate: the real Claude and Codex timing of hooks
after an interrupt has not been measured yet (it needs the `debug` skill's controlled real-Agent
procedure, recording only hook names and timestamps), so whether these providers emit such late
hooks at all is unconfirmed.

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

While a Terminal is suspended, the PrimarySidebar's Session row describes it as `Suspended` in the
neutral tone (not the idle state it last probed) and its accessible description says the Agent
resumes when the Session is opened, naming Settings > Agents. The Terminal's recovery row reads `Suspended in the background,
resuming`, and its tooltip names the same setting. Neither claims the idle rule caused the park,
because the record does not say whether the idle rule, an archive, or a Process Explorer stop
parked it.

[Airplane Mode](airplane-mode.md) detaches every live Agent at once before the user goes offline and
holds new Agent launches until the user picks which Sessions to resume.

## Logging

Both transitions are logged without any Terminal or transcript content:

- `terminal.suspended`: the closed `reason` (`idle`, `observation`, `untouched`, `archived`,
  `detached`, `requested`, `terminated`), the provider, and for the automatic reasons `idleMs` (since
  the last activity) and `backgroundMs` (since the Session was left).
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

## Agent Chats

An Agent Chat is considered by the idle rule only; the untouched rule judges launch and input
samples a Chat does not record. Besides the conditions above, the Chat's own projection must report
nothing pending (`AgentChatService.isSuspendable`): its provider is ready and bound to an Agent
Session, and no turn, approval or question, operation (compaction), running background task, or
queued message remains. An unbound Chat is never parked, because it has no conversation to resume.
A Chat a paired phone has open (an `agentChat` subscription) counts as viewed, like a phone-watched
Conversation, so a reply sent from the phone never finds its provider stopped.

A Chat whose provider only a read started also holds an observation lease
(`AgentChatService.readLeaseAt`): it is parked with reason `observation` two minutes
(`CHAT_OBSERVATION_LEASE_MS`) after its Session is left, even with idle suspension off, so browsing
history never leaves a resident provider. At most `MAX_CHAT_OBSERVATION_LEASES` (3) leases wait out
that window: a read that starts one more requests an immediate sweep, which parks the oldest unexpired
leases beyond the newest three, so browsing many Chats in a row keeps a bounded number of providers.
Any input to the Chat ends the lease, and the park re-checks it when it reaches the head of the send
chain. The same exemptions as the idle rule apply.

Parking a Chat (`AgentChatService.suspendIdle`) runs on its send chain, so input accepted first is
delivered first. It stops the provider process but keeps the in-memory conversation, so every
Client still shows it. The provider's requested exit records the Terminal as `suspended` rather than
`stopped`, whenever that exit lands, and the next start clears the mark. Selecting the Session starts the
provider again on the same Agent Session; so does a message or a read from any Client. A Chat that
an earlier Server Core left `suspended` resumes lazily on its next read, like any Chat after a
restart. Grok Build Chats are eligible because a Chat resumes through the provider's session
protocol rather than a PTY restore.

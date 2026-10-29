# Terminal launch, suspension, and recovery

Server Core resolves only discovered allowlisted programs (`$SHELL` or a registered Agent provider),
builds structured launch plans with a persisted cwd and filtered environment, and sends those plans over
the private protocol. Terminal Host exclusively spawns and owns the resulting PTYs. Each provider owns
bounded launch executable and argument settings; configured initial args precede provider-owned resume
args. Agent executables use a cached, bounded login-shell PATH shared with version probes, while normal
Shell Terminals retain their existing login-shell startup. Agent processes (PTY launches, Chat
providers, rename one-shots) start from every variable the user's interactive login shell exports
(`agentProcessEnvironment` in `apps/server/src/domains/executables.ts`), so API keys and toolchain
variables from startup files match the user's own terminal; Caxri's allowlisted launch context wins
over that snapshot (an isolated test `HOME` or `CODEX_HOME` stays), the login-shell PATH wins over
both, and shell bookkeeping (`PWD`, `SHLVL`, ...) and the `CAXRI_*` namespace are dropped. The
snapshot is re-read in the background once an Agent launch finds it a minute old; that launch and
any during the re-read use the previous snapshot, so only the first probe is ever waited for. At most
one probe runs at a time, and each one logs `login_shell.probe` with its duration and a closed failure
reason, or per-cause counts of the variables it dropped (never names or values). Variables that only Caxri's own
process environment carries (a workflow marker, a token exported to the shell that started Caxri)
are still excluded.

Desktop Main forwards a narrow E2E-only Agent policy to Server Core: default launches block every
provider, fake mode maps declared providers to absolute fixture executables, and real mode permits
production discovery for exactly one provider. Terminal launches and metadata/version probes share that
policy; isolated login profiles also prepend generated fake-or-blocked shims so typing a provider name
in a Shell cannot fall through to a machine-installed CLI. Focused Electron coverage may request a
bounded E2E-only Terminal output flush delay through the Desktop-to-Server-to-Terminal Host allowlist;
production keeps the fixed 16 ms coalescing window.

Terminal Host frames complete ANSI controls before sending the same boundary to its screen parser and
live delivery queue. A snapshot never captures half a cursor command; complete controls are queued
atomically, while plain text can be byte-bounded. Incomplete controls retain at most 128 KiB (larger
than the supported OSC 52 envelope); an oversized control is omitted through its terminator with a
visible, content-free notice. Image recovery and live delivery keep their independent 64 KiB policy.
The serialized screen patch clips hidden alternate-buffer columns after a shrink and preserves the
full-width cursor, including genuine pending wrap. Keep the screen and engine-output regressions when
upgrading xterm; see the patched dependency notes in `stack-baseline.md`.

Mobile Terminal observers use a Host-owned stream separate from the Desktop attachment and its output
queue. Registering an observer flushes the previous stream batch, records the next sequence, then crosses
the parsed-screen snapshot barrier. Later framed and image-filtered output can arrive before the snapshot
reply; the mobile subscription holds it until snapshot chunks finish and checks the Host sequence before
delivery. Desktop attach, reattach, and detach never remove observers or resize on their behalf. Host
observer overflow and screen-parser reset emit a content-free gap and restart the observer stream; each
mobile subscription has its own bounded outbound queue, so one slow phone cannot stall a PTY or Desktop.
An observer and its size lease retire with the PTY generation, and a replacement PTY requires a fresh
snapshot rather than continuing an old byte stream.

When at least one provider lifecycle integration is enabled, every Shell PTY receives its own observation-only
hook generation, socket path, and token before spawn. A managed Agent child overrides that context with an
independently revocable hook generation. Its exit restores Shell observation for manual CLI relaunches while
retiring its Agent Endpoint authority. Shell restart, exit, suspension, and close revoke the Shell context before
retiring the child, so an old fallback cannot be reactivated. A new Terminal resolves the global default cwd
(`~` supported) or falls back to the Session's current Workbench Root before its durable record is inserted;
restarts always reuse that record, and explicit file actions may request a cwd inside either the owning Project
or the current Workbench Root. Switching roots never moves or restarts an existing Terminal. Switching Sessions
detaches views but does not stop PTYs. Renderer output delivery is coalesced; per-Terminal queues have a
byte ceiling and report a discontinuity when the Renderer cannot keep up. The Renderer discards that
incomplete batch and requests a fresh authoritative screen attachment, coalescing further gaps during
recovery into one follow-up attachment. Durable Terminal creation is capped at 16 per Session and 32
globally. The Renderer bundles JetBrains Mono's four terminal faces plus Symbols Nerd Font Mono as a
fallback and loads them before xterm measures its cells, so packaged builds do not depend on
system-installed terminal fonts.

Provider output recovery is an explicit, disabled-by-default Terminal steering policy for unstable Agent
connections. Terminal Host combines reviewed provider-owned literal suffixes with bounded user patterns,
then matches them case-insensitively only after the latest PTY output has settled in the parsed
headless-xterm screen; ANSI bytes and arbitrary raw chunks are never match inputs. Built-in suffixes stay
in the matching implementation so an application upgrade can repair provider wording without rewriting
or freezing user settings. A built-in rule requires an exact provider-owned line above reviewed,
content-free cursor chrome, so submitted prompts cannot satisfy it; user-authored rules retain literal
suffix matching. A match is fenced to the exact live PTY generation, sends fixed Escape and
`continue` bytes with separately bounded delays, yields immediately to real user input, and is canceled
by settings or lifecycle changes. The same suffix cannot fire again until parsed output stops matching
it, and a rolling three-attempt limit prevents unattended loops. Logs and transient feedback carry only
Terminal/provider/status/rule-source metadata; built-in suffixes, user-authored patterns, and Terminal
content never enter events, logs, or diagnostics exports.

Closing the last macOS window with live PTYs asks whether to keep running, terminate and close, or
cancel. `Keep Running` detaches every Renderer view and closes the window while Server Core, Terminal
Host, and PTYs remain alive; reopening creates a new window and attaches it to the live Server.
`Terminate and Close` sends `terminal.terminateAll`, which ends work, not the Server: it fences queued
restores, stops every live PTY as `stopped` along with any launch that lands while it runs, then, once
every launch in flight settled, stops every live Chat as `stopped` and returns. A stopped PTY is never
auto-restored; a Chat starts lazily on its next read, as after any Server Core restart
(`docs/agent-chat.md`). Server Core, the Terminal Host, and every
Server service keep running, so a window reopened from the Dock creates, restarts, and restores Terminals
and starts Chats on the same Server. `Quit Caxri` stops an idle Server without prompting. With live PTYs
it asks whether to terminate every Terminal and Agent process before `host.stop`, keep work attached to
the background Server, or cancel; the non-destructive keep-running choice is the default. Terminating
before quitting is the same `terminal.terminateAll`; the Server's terminal shutdown is the `host.stop`
that follows, whose orderly shutdown then finds nothing left to mark `interrupted`. Other connected clients are called out in the stop
warning, and an idle Server remains alive without prompting when another client is connected. System
shutdown and explicit Desktop relaunch preserve work without prompting. Dead Terminals remain visible
and can be restarted. In-flight Agent CLI discovery is revalidated against durable metadata before a PTY is
registered, so closing a Terminal or deleting its Session cannot create an orphan process.

Interrupted-Terminal recovery is supervised by one Server Core-wide four-spawn budget. Selecting a Session invalidates queued restore work from the previous selection, and the selected generation is revalidated after executable discovery immediately before PTY spawn. A visible interrupted Terminal retains the receiving Renderer grid before restore, starts its PTY and parsed screen at that grid when possible, and performs one ordered live-screen reattach after the record becomes `running`; this removes any remaining attach/spawn race without relying on a later ResizeObserver event. Startup Agent metadata probes are limited to the selected Session; another Session is probed when selected rather than during boot.
The visible-grid wait resolves as stale work when its restore generation is canceled across both in-process and private
Terminal Host execution adapters, and so does a generation that goes stale during launch preparation; both must leave
the durable Terminal `interrupted`, never convert an ordinary Session switch into `failed` / `spawn_failed`.

Background Agent suspension is Server Core's only automatic PTY teardown. A `TerminalSuspensionService` sweep
(`WatchHub` poller) parks Agent Terminals of unselected, unarchived Sessions by killing the PTY behind the restart
barrier, capturing the final screen, and moving the durable record and Agent state to `suspended`; the record,
scrollback, and bound Agent session id survive, and the interrupted-restore path relaunches the Terminal with the
provider's resume arguments when its Session is selected again. Two rules apply, both driven by in-memory activity
(launch, Core-delivered input, accepted lifecycle signals, and Session selection): an untouched Agent that received no
input and started no turn since launch is suspended shortly after its Session is left
(`terminal.suspendUntouchedAgents`), and an Agent idle at its prompt in a background Session is suspended after the
configured window (`terminal.idleSuspension.*`, off by default). The selected Session and any Terminal a phone is
observing are never touched, an Agent mid-turn or awaiting the user's approval or answer is never suspended, and Shell
tabs are not eligible. A background Agent Chat whose provider only a read started is parked two minutes after its Session is left (`observation`, independent of the setting), and an idle one by the idle rule: its provider process stops, its projection stays, and selection starts it again. The full eligibility rules, settings, and transition logs live in
[docs/agent-suspension.md](../../../../docs/agent-suspension.md). Archiving a Session
or hiding its Project suspends all of its live Terminals once restores already past their spawn fence settle; a PTY
whose Terminal Host start answers after that is parked as soon as it lands (`TerminalSuspensionService.parkLaunch`), so
no launch outlives its Session leaving the Workbench. Terminal capacity counts only `starting` and `running` records so dormant tabs do
not consume the limit.

`detached` is the user-driven sibling of `suspended`: `session.detach` parks a Session's live Agent Terminals (never
its Shell tabs) through the same barrier so another client can `codex resume` / `claude --resume` the bound
conversation, which Codex refuses to open twice. Selecting the Session does not relaunch a detached Terminal; only the
explicit `session.resume` request (or the Terminal's own Resume action) opts it back into the restore path with the
provider's resume arguments. An Agent launch of the Session still in flight when the detach begins (`terminal.create`,
`terminal.restart`, a surface switch, a dispatch) had no process to park; `parkLaunch` parks it as `detached` when it
lands, and the detach returns only after every such launch settled. That includes a request still doing its pre-launch
work (working-directory identity, Agent Session lookup): each such handler holds an `InFlightLaunches.begin` span for
its Session from before its first await until `start` or `restart` tracks the launch, so a detach waits for it too, and
a Chat relaunch that lands meanwhile is closed by the detach's own Chat close. `session.resume` and `session.detach` share the
Session lock (`MobileTerminalMutationQueue.runSessions`), taken inside the Session selection queue, so a resume sent
while a detach runs waits for it and then relaunches everything it handed over.

[Airplane Mode](../../../../docs/airplane-mode.md) detaches every Session with a live Agent through the same
`detachSessionAgents` and, while it holds, makes `launchParkReason` return `detached` for every Agent launch (the
Airplane fence on `TerminalSuspensionService`) and refuses Chat starts in `ensureChatStarted`. Its resume runs on a
dedicated `TerminalRestoreSupervisor`, Session by Session, so it never aborts the selected Session's restore.

Exited Terminals retain their final output and reserve a compact recovery row beneath the xterm viewport, never over it. A zero exit without a signal is neutral; startup failures and signal or non-zero exits use a danger state. Surface actions, the command palette, and `Command+Shift+R` restart the same durable Terminal record, so recovery cannot create a duplicate tab or PTY identity. Restarting a bound Agent Terminal resumes its correlated provider session by default; only the separate `Start New Conversation` action (`terminal.startNewAgentSession`; the id keeps its old name so saved keybindings resolve) clears that binding and starts fresh, and it always asks first, even for an idle or exited Agent, because no later Restart can bring the old binding back, while Shell restarts always remain fresh. A detached Agent's recovery row offers Resume instead of Restart: it sends `session.resume`, which brings back every Agent the Detach parked in that Session. The Session row menu (for its Primary Agent) and an Agent Terminal tab menu expose the same resume restart as `Restart Agent`. A resume restart keeps the approval mode the replaced Agent Run launched with: `AgentRunAutonomy` (one instance in `TerminalLaunchPlanner` for PTY Agents, one in `AgentChatService` for Chats) remembers, per Terminal and only for the current Server Core generation, whether that run's launch arguments carried the provider's autonomy (YOLO) tokens, and the restart forces them present or absent on the current Settings arguments. Every other argument follows the current Settings; a fresh restart and the Session-selection restore path use the current Settings unchanged.

Server Core retains each reusable Terminal's PTY generation across natural exit, failed launch
(`discard`), restart barriers, and Terminal Host exit. Host authorization expects the next generation
for that same ID, so none of those paths may reset it. Only permanent Terminal closure, which deletes
the durable record and never reuses its ID, releases the Core generation entry; Core shutdown clears
all entries. A late Host start response must not recreate an entry after permanent closure.

Terminal Host keeps the mirror ledger (`terminal-host/generation-ledger.ts`): the last started
generation per reusable ID, so `terminal.reserve` must name exactly the next one. A Host with no entry
for an ID, such as a replacement Host after a crash, accepts Core's first positive generation. The two
Host-facing stop paths are distinct signals: `terminal.stop` (restart barrier with `persistSnapshot:
true`, or `discard` with `false`) keeps the baseline, while permanent closure sends the server-scoped
`terminal.retire { terminalId }`. Core sends it even when the PTY already exited and no identity
remains, skipping it only when no Host is running. Retirement drops the ledger entry, the Host
identity, and the PTY, and adds the ID to a FIFO fence of `RETIRED_TERMINAL_FENCE_LIMIT` (256) IDs;
a fenced ID's reserve or start fails with `retired`. Removing the entry without the fence would let a
late reserve fall back to the no-baseline rule.

`terminal.start` also requires a matching not-yet-running reservation on the same Host boot, so a
start whose reservation was discarded, retired, or lost with a previous Host fails without any
per-ID history. Core never issues such a request: its launch path rechecks the durable record
immediately before `terminal.reserve`, and `start` refuses to send once its reserved identity was
replaced while the reservation settled. The fence is therefore defense in depth for requests
already in flight; a burst of more than 256 later retirements evicts the oldest IDs first.

`terminal.stop` (`terminal-host/generation-stop.ts`, authorized in `terminal-host/authorization.ts`)
seals its generation at admission, before it waits for managed Agent cancellation (up to the
launcher's grace period), because the Host authorizes every concurrent request against that identity
during the wait. A sealed generation is refused with `sealed` for input, Agent input and submit,
observer input and scroll, resize, observe and take-over, both signals, and a late `terminal.start`;
it keeps only view reads and binding (`attach`, `detach`, `snapshot`, `waitForAttachedSize`,
`textTail`, `resources`), observation release, `reassign`, `configure`, and a repeated
`terminal.stop`, because Server Core still re-attaches, reassigns, and retries the restart barrier
of a stopped Terminal before its next reservation. A repeated stop with the same snapshot policy
joins the one in flight and shares its final snapshot; one with the other policy runs after it
settles. The seal is never cleared; the next generation starts from a fresh reservation identity.
While a sealed generation is still running, its stop has not reached the PTY yet, so
`terminal.reserve` for the ID is refused with `sealed` too. A failed Agent cancellation is logged
and the stop still ends the PTY, so a seal cannot strand the Terminal. After the wait, the stop acts
only if the ID still names the identity it sealed; natural exit, retirement, and Host shutdown
already disposed of the PTY otherwise. `engine.start` fails with `CONFLICT` instead of adopting a
live PTY that still owns the ID, and a failed `terminal.start` restores the previous identity and
colors only if its own reservation is still current.

Server Core keeps its own traffic clear of the seal. `reserve` waits for a failed launch's
background `discard` stop (`core/terminal-host/discard-stops.ts`) to settle before it asks for the
next generation, so a quick retry is not refused. Once `restartBarrier` sends its stop, Core drops
Renderer keystrokes the way it drops input to an exited Terminal and only records resize dimensions
for the next attachment, instead of turning each into a Host refusal the Renderer would report as an
error.

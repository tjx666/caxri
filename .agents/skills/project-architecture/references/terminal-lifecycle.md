# Terminal launch, suspension, and recovery

Server Core resolves only discovered allowlisted programs (`$SHELL` or a registered Agent provider),
builds structured launch plans with a persisted cwd and filtered environment, and sends those plans over
the private protocol. Terminal Host exclusively spawns and owns the resulting PTYs. Each provider owns
bounded launch executable and argument settings; configured initial args precede provider-owned resume
args. Agent executables use a cached, bounded login-shell PATH shared with version probes, while normal
Shell Terminals retain their existing login-shell startup. Standard proxy and custom-CA variables are
retained, while unrelated credentials and Caxri-internal variables are excluded.

Desktop Main forwards a narrow E2E-only Agent policy to Server Core: default launches block every
provider, fake mode maps declared providers to absolute fixture executables, and real mode permits
production discovery for exactly one provider. Terminal launches and metadata/version probes share that
policy; isolated login profiles also prepend generated fake-or-blocked shims so typing a provider name
in a Shell cannot fall through to a machine-installed CLI. Focused Electron coverage may request a
bounded E2E-only Terminal output flush delay through the Desktop-to-Server-to-Terminal Host allowlist;
production keeps the fixed 16 ms coalescing window.

When at least one provider lifecycle integration is enabled, every Shell PTY receives its own observation-only
hook generation, socket path, and token before spawn. A managed Agent child overrides that context with an
independently revocable hook generation. Its exit restores Shell observation for manual CLI relaunches while
retiring its Agent Endpoint authority. Shell restart, exit, suspension, and close revoke the Shell context before
retiring the child, so an old fallback cannot be reactivated. A new Terminal resolves the global default cwd
(`~` supported) or falls back to its Project root before its durable record is inserted; restarts always
reuse that record, and Files/Git authorization remains anchored to the Project root. Switching Sessions
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
Host, and PTYs remain alive; reopening creates a new window and attaches it to the live Server. `Quit
Caxri` stops an idle Server without prompting. With live PTYs it asks whether to terminate every Terminal
and Agent process before `host.stop`, keep work attached to the background Server, or cancel; the
non-destructive keep-running choice is the default. Other connected clients are called out in the stop
warning, and an idle Server remains alive without prompting when another client is connected. System
shutdown and explicit Desktop relaunch preserve work without prompting. Dead Terminals remain visible
and can be restarted. In-flight Agent CLI discovery is revalidated against durable metadata before a PTY is
registered, so closing a Terminal or deleting its Session cannot create an orphan process.

Interrupted-Terminal recovery is supervised by one Server Core-wide four-spawn budget. Selecting a Session invalidates queued restore work from the previous selection, and the selected generation is revalidated after executable discovery immediately before PTY spawn. A visible interrupted Terminal retains the receiving Renderer grid before restore, starts its PTY and parsed screen at that grid when possible, and performs one ordered live-screen reattach after the record becomes `running`; this removes any remaining attach/spawn race without relying on a later ResizeObserver event. Startup Agent metadata probes are limited to the selected Session; another Session is probed when selected rather than during boot.
The visible-grid wait resolves as stale work when its restore generation is canceled across both in-process and private
Terminal Host execution adapters; it must leave the durable Terminal `interrupted`, never convert an ordinary Session
switch into `failed` / `spawn_failed`.

Background Agent suspension is Server Core's only automatic PTY teardown. A `TerminalSuspensionService` sweep
(`WatchHub` poller) parks Agent Terminals of unselected, unarchived Sessions by killing the PTY behind the restart
barrier, capturing the final screen, and moving the durable record and Agent state to `suspended`; the record,
scrollback, and bound Agent session id survive, and the interrupted-restore path relaunches the Terminal with the
provider's resume arguments when its Session is selected again. Two rules apply, both driven by in-memory activity
(launch, Core-delivered input, validated lifecycle turns, and Session selection): an untouched Agent that received no
input and started no turn since launch is suspended shortly after its Session is left
(`terminal.suspendUntouchedAgents`), and an Agent idle at its prompt in a background Session is suspended after the
configured delay (`terminal.suspendIdleAgents`, off by default). The selected Session is never touched, an Agent
mid-turn or awaiting the user's approval is never suspended, and Shell tabs are not eligible. Archiving a Session
suspends all of its live Terminals. Terminal capacity counts only `starting` and `running` records so dormant tabs do
not consume the limit.

`detached` is the user-driven sibling of `suspended`: `session.detach` parks a Session's live Agent Terminals (never
its Shell tabs) through the same barrier so another client can `codex resume` / `claude --resume` the bound
conversation, which Codex refuses to open twice. Selecting the Session does not relaunch a detached Terminal; only the
explicit `session.resume` request (or the Terminal's own Resume action) opts it back into the restore path with the
provider's resume arguments.

Exited Terminals retain their final output and reserve a compact recovery row beneath the xterm viewport, never over it. A zero exit without a signal is neutral; startup failures and signal or non-zero exits use a danger state. Surface actions, the command palette, and `Command+Shift+R` restart the same durable Terminal record, so recovery cannot create a duplicate tab or PTY identity. Restarting a bound Agent Terminal resumes its correlated provider session by default; only the separate `Start New Agent Session` action clears that binding and starts fresh, while Shell restarts always remain fresh.

---
name: debug
description: Diagnose Caxri failures across Desktop Main, Server Core, Terminal Host, Extension Host, secure Preload, React Renderer, PTY, SQLite, file watcher, Git, and packaging boundaries. Use for crashes, blank windows, IPC failures, stale state, terminal lifecycle bugs, packaged-only failures, stopping a launched unpackaged instance, verifying Server freshness, visual UI confirmation, or live CDP inspection of a running dev or production app in this repository.
---

# Debug Caxri

A reported product failure is a repair task unless the user explicitly requests analysis only.
Reproduce the failing boundary, fix the verified cause in a task worktree, and validate the repair.
A plausible explanation or a manual recovery command is not completion; use recovery advice only
to unblock the user while the authorized repair continues. If evidence requires user input, retain
the active repair scope when that input arrives.

1. Reproduce with the narrowest real process path. For interactive Electron behavior, agents always
   use `bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev` so the checkout owns
   an isolated profile and Desktop lease. Bare `bun run dev` is only a first-clone convenience for a
   human working outside an agent session.
   For TUI interaction failures, compare the reported working app/CLI combinations, then trace one
   failed keyboard or mouse event through xterm `onData`/`onBinary`, IPC, and PTY before assigning
   the fault to Caxri or the CLI.
2. Identify the owner from the `project-architecture` skill's architecture reference: Desktop Main
   for windows, dialogs, the Desktop lease, and the runtime profile; Server Core for Projects,
   Sessions, SQLite, settings, and the public command surface; Terminal Host for PTYs; Extension
   Host for native ESM extensions; Preload for the typed bridge; Renderer for UI. Frozen public
   identifiers such as `host.stop` are compatibility names, not current owners.
3. Inspect structured Desktop Main, Server Core, Terminal Host, and Extension Host logs together
   under the active runtime profile's `<userData>/logs/` directory. Compare correlation IDs and
   boundary timings. Repeated Renderer requests may come from StrictMode, but must not duplicate
   expensive native work.
4. Trace the typed method and event from its owning `packages/protocol` domain through the Server
   dispatcher, Preload, and Renderer consumer. Treat the selected Session root as a security and
   state-lifetime boundary.
   For external deployment reports, pin the screenshot's deployment ID or hostname and commit
   before comparing states. A redeploy changes the evidence: query that deployment and bounded
   history through the provider CLI instead of using the latest PR or deployment state to explain
   an earlier screenshot. Distinguish row selection, state mapping, and click destination; do not
   change which deployment a row represents when the reported defect is its destination.
   When the user supplies a reference icon, inspect its interior shape as well as its outline;
   a similar glyph with different semantics (such as eye-off versus eye-with-magnifier) is not
   an equivalent replacement.
5. Never print terminal output, file contents, credentials, or snapshots. Apply `AGENTS.md`'s
   trusted workspace-link policy when diagnosing file navigation; preserve the boundary against
   arbitrary outside paths instead of rejecting every external link target.
6. Add a focused regression test at the lowest useful layer. Use Electron E2E when the process
   boundary is part of the failure.
7. Call the Skill tool with "quality-check" with the changed source and regression test before any
   broader suite.

Manual refresh, reopening a panel, or restarting a process only proves a recovery path. When it
clears a reported stale-state failure, continue tracing the missing invalidation through its owner,
reproduce it with the narrowest fixture, and repair the confirmed cause and directly related paths.
Do not end at a workaround when the next diagnostic or repair step is known and authorized; stop
only for an explicit scope limit or a concrete blocker requiring the user's decision or authority.

## CI watcher diagnosis

For CI-only native watcher failures, a successful subscription is not a health check. Compare a
real file write and its raw callback with the artifact-runtime delivery probe before blaming
application invalidation. Inspect old CI-owned Server trees and system event-service resources
through the failed hosted job's content-safe artifacts without logging process environments. Keep
the first failure, exact runner image, and targeted reproduction together. Never replace missing
hosted evidence with SSH access, a machine-wide cleanup, or an unrequested local full-suite run.

## Controlled real-Agent debugging

When a fake Agent cannot reproduce a provider-owned PTY or input-protocol behavior, debugging may
launch one explicitly selected real Agent CLI process. This is a diagnostic exception, not permission for
ordinary E2E, CI, or Acceptance to discover or invoke a host provider.

- Use an isolated profile or an already authorized Project, the narrowest read-only sandbox
  available, no approval prompts, and one predeclared bounded input. Do not automate or persist a
  provider trust decision merely to create a temporary Project; fence an existing Project with
  before/after session identities instead. Never fall back to another provider.
- Except for the explicitly authorized public-safe Hook/mod contract probe below, do not read,
  screenshot, record, print, or persist Terminal output, prompts, responses, or Agent transcripts.
  Otherwise observe only content-free signals such as exact input bytes, process lifecycle,
  provider turn state, structured status events, and exit status.
- Stop every process started by the probe, interrupt any submitted turn, and remove exact diagnostic
  sessions or temporary state without touching unrelated user sessions.
- Submit each mutating CDP operation once, then observe it through short read-only calls. Keep a native
  delegation ID across waits: a bounded `agent.delegation.wait` may return an active receipt rather
  than an error. Continue reading that task until terminal status; never replay a long browser
  evaluation containing creation or continuation merely because its transport timed out.
- Treat the result as debugging evidence. Automated coverage still uses deterministic fake fixtures;
  Acceptance still proves the product surface without invoking a host provider.

## Runtime profile, shutdown, and visual proof

Unpackaged (dev) launches default to an isolated `caxri-dev` userData profile (own Server, SQLite,
and logs) so they never contend with the installed production app. A bare `bun run dev` honors
`CAXRI_USER_DATA_DIR` (`apps/desktop/src/main/desktop-profile.ts`); `switch-worktree dev` always sets
its own and takes `--user-data-dir` instead.

Stop every dev instance you started before reporting a request complete, and verify it actually
died. One launch leaves five separate processes: the `electron-vite dev` launcher, the Electron
window process (whose `ps` command is `Caxri Dev`, not an Electron binary path), and the detached
`<worktree>/apps/server/dist/server/bundles/server-core.js` and `extension-host.js`. Stop all of
them with

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts stop
```

which resolves ownership from this worktree's absolute path and the launcher's process record, then
escalates SIGTERM to SIGKILL and exits non-zero on survivors. Each survivor carries a closed reason
when the signal itself never landed (an identity mismatch or a refused `process.kill`); one with no
reason was actually signaled but had not exited yet. Do not treat a non-zero exit as "already
cleaned up" or retry blindly; read the reason codes and the per-PID manual-verification steps in
`switch-worktree`'s "Stop what this checkout started" section before falling back to a manual kill.

Never terminate by name or bundle pattern. `pkill -f "Electron.app/Contents/MacOS/Electron"`
silently misses the window process and the launcher can outlive the signal; `pkill -f "Caxri.app"`
matches the installed `/Applications/Caxri.app` and has already killed it mid-session while an agent
was cleaning up an interrupted local E2E pool. Never trust `pkill`'s exit code. Confirm with
`ps -axo pid,command` plus a CDP probe of this worktree's port (see "Live CDP inspection" below for
where to read it; do not assume 9223). Kill a PID directly only after matching it against the
absolute `<worktree>/` path, so a sibling worktree's session and the installed application are never
hit.

The dev Server Core and Extension Host are long-lived background processes that survive window
restarts. The Desktop replaces a Server whose build fingerprint differs from its own on connect,
but that only triggers when a window reconnects: a headless Server can still serve stale code
between launches. Before using a live instance to verify or disprove a Server change, confirm
the `apps/server/dist/server/bundles/server-core.js` and `extension-host.js` process start times
postdate the change (`ps -axo pid,lstart,command`), and restart them when they do not.

A user-visible Renderer/UI change is not done until it has been verified visually in the running
dev app. Drive the real application over CDP, capture a screenshot of the affected surface, and
check it before reporting completion. Passing unit or e2e gates alone does not count for visual
changes.

Wait for the intended surface to render before capturing it. For a file preview, match the asset's
accessible name and decoded dimensions; the first loaded `img` may only be an Agent's brand icon.
Wait for a paint frame, then inspect the captured pixels. A loaded node alone does not prove a preview.

For Agent transcript adapters, verify event visibility in both directions: normal Hook lifecycle
output (plain text, empty JSON, and control JSON) stays out of Chat, while explicit user feedback
and command results remain visible. Replaying an event successfully is not proof that it belongs
in the conversation. Ground fixtures in the installed provider's actual event and persisted-record shapes; a fabricated
message only proves the renderer, not provider integration. Verify both live delivery and
Terminal-to-Chat history restoration, preserve warning/error severity and readable reasons, and
inspect CDP captures for each path, including multiline text, adjacent action alignment, and
source/severity distinctions. When the user authorizes a real Hook/mod reproduction, use a
one-off public-safe plugin and isolated configuration, block model network requests, and capture
only that test's generated feedback. Never use private hooks or existing business transcripts.

For ordinary Agent UI verification in a dev instance, run fake providers. Outside the controlled
exception above, never discover or invoke a host CLI. Prepare a task-owned fixture folder and start
the dev instance with its exports; `--provider` takes `claude` (default), `codex`, or `grok`:

```bash
eval "$(bun run .agents/skills/debug/scripts/fake-agent-development-environment.ts /tmp/<task> --provider claude)"
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev --user-data-dir /tmp/<task>/profile
```

The exports include `CAXRI_E2E=1`; without it the fake executables are ignored while the isolated
`CODEX_HOME` still applies, so the real Codex CLI starts at its login screen. Before using the Agent,
confirm with `ps` that the Agent process is the fake `e2e-agents/bin/<provider>`. `CAXRI_TEST_ROOT_PATH`
points at `/tmp/<task>/project`, so Add Project (`Cmd+O`) uses the existing test-root grant without a
native folder picker. A new Agent opens as a Terminal unless `session.openAgentsInChat` is on; the
tab bar's Chat toggle switches an open one. Run the repeated Caxri steps through
`.agents/skills/debug/scripts/drive-app.ts` instead of hand-writing Playwright: `language en`
(English labels for the E2E helpers), `open-chat <claude|codex|grok>` to add the test-root Project
and open that Agent in Chat (driving the dialog by hand lets the root grant expire, and
`project.create` then fails with `PATH_DENIED` and no Session), `send <text>` into the Chat message box, `paste-image [count]` to paste synthetic PNGs there without the system clipboard, `idle` until a reply
stops changing the window, `search <query>` in Session search, `ready [seconds]` until a relaunched
window answers (instead of a fixed sleep), `select-session <id prefix|title>` to open a sidebar
Session, and `screenshot <absolute path>`; every step also takes `--screenshot <absolute path>`. It reaches the same checked window as `worktree-browser.ts`,
which stays the tool for generic clicks and snapshots. A step it lacks goes into that script, not a
throwaway one. `settings.update` takes `{ source }`, the whole settings JSON as a string, never a
partial patch. If the fixture's test root does not cover the flow, export
`V8_INSPECTOR_PORT=<port>` (electron-vite passes it to Main as `--inspect`) before `dev`, then run
`drive-app.ts stub-folder-dialog <absolute path> --inspector-port <port>` so Main's folder picker
returns that path, as `e2e/support/packaged-project-dialog.ts` does. Prefer `switch-worktree dev --user-data-dir <absolute
task temp dir>` for a fixture run, so fixture Projects never reach the worktree profile. Otherwise, before stopping, close every fixture Terminal, archive its Sessions
(`session.archive`), and verify `app.bootstrap` contains no fixture Agent Terminals. A later plain
`dev` run must not restore a synthetic conversation with a real CLI. Do not delete the Project
through `window.caxri.request('project.delete', ...)`: Main answers it with a native confirmation
dialog, so the CDP evaluation hangs and the dialog takes the user's focus.

A change limited to native menu entries (Renderer menu data that Main draws with `Menu.popup`) has
no CDP-visible surface. Verify it with a Playwright Electron spec that opens the menu from its real
trigger through `e2e/support/native-context-menu.ts`, asserts the entry's label, position, and
enabled state, and chooses it end to end; then state in the report that the dev-app screenshot does
not apply. Any accompanying DOM change still needs the CDP screenshot. Capture a real native popup
only when the user explicitly asks to verify native rendering: it needs synthesized foreground input
(a native folder dialog to grant a Project root, then the popup itself) that `switch-worktree`
limits.

For native load failures, run `bun run spike:native` and `bun run spike:pty`, then verify the
packaged app rather than assuming the development ABI matches.

For a macOS GPU incident, collect at most a 30-minute system window with:

```bash
bun run .agents/skills/debug/scripts/collect-macos-gpu-logs.ts \
  --start 2026-08-28T14:50:00+08:00 --end 2026-08-28T15:05:00+08:00
```

The script queries only Caxri's GPU helper, WindowServer, Dock, and kernel GPU/Metal/Space events.
It emits bounded signal enums and process metadata, never raw unified-log messages, paths, Terminal
content, environment values, or credentials.

## Live CDP inspection

Use raw CDP when the experiment controls debugger attachment itself: an automation client's
auto-attach/resume behavior can invalidate that experiment. Retain owned-port and process checks.
When an isolated provider HOME also covers a dev build, pass the verified pinned Node executable
through `CAXRI_SERVER_RUNTIME_EXECUTABLE`; runtime discovery must not fall back to that empty HOME.

Packaged (production) builds expose CDP at the fixed `127.0.0.1:9224` (`CAXRI_DEV_CDP_PORT`
overrides it). A production-build issue can usually be inspected by connecting to the running
installed app there directly; whether that suffices or a dev relaunch is still needed depends on
the problem. The `remoteDebugging` field in the Main-owned boot config
`<userData>/config/argv.jsonc` (Settings → "Debugging port") turns the endpoint off on the next
launch (`apps/desktop/src/main/desktop-profile.ts`).

An unpackaged (dev) instance's port is **not** a fixed constant: `switch-worktree dev` (see the
`switch-worktree` skill) derives a stable port per worktree so simultaneous dev instances in sibling
worktrees never collide, and prints it in its own startup output before the launcher blocks. Read
it from there, or from `switch-worktree list --json`'s `cdpPort` field for the target worktree:
never hardcode 9223. A bare `bun run dev` outside the wrapper is the only case that still defaults
to the fixed 9223.

For this worktree's own dev instance, run every agent-browser command through the wrapper, which
applies all the rules below on each call: it reads the port from the dev process record, strips
the proxy variables, pins a per-worktree `--session`, and refuses to run unless
`__caxriWorktree` equals this checkout:

```bash
bun run .agents/skills/debug/scripts/worktree-browser.ts eval "document.title"
bun run .agents/skills/debug/scripts/worktree-browser.ts screenshot /tmp/<task>/panel.png
```

Pass `--packaged` first to reach the installed app on 9224 instead; the wrapper then requires a
`Caxri/` user agent and no `__caxriWorktree`. Use the manual form below for another worktree's port.

For a scrollbar that flashes or a transcript that moves by itself, record instead of hand-writing
loggers: `scroll-trace.ts start|read|reset [--packaged] [--json]` patches every programmatic scroll
on `[role="log"]`, records content-free scroll, write, and row-resize entries, and marks a scroll
that showed the scrollbar without user input as `REVEAL`. A reload removes the recorder. For a
cold-open case: select another Session, `switch-worktree stop`, relaunch `dev`, `drive-app.ts ready`,
`scroll-trace.ts start`, `drive-app.ts select-session <target>`, then `scroll-trace.ts read`.

Connect with `agent-browser`, always stripping proxy environment variables and passing the port
through `--cdp` (not the `connect` subcommand, which can launch a fresh, disconnected browser
instead of attaching, see [common-mistakes.md](../../acceptance/common-mistakes.md#reaching-the-owned-electron-endpoint-with-agent-browser-connect)):

```bash
PORT=<port from switch-worktree dev output, list --json, or 9224 for packaged>
env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy \
  agent-browser --cdp "$PORT" snapshot
```

The `env -u` prefix is mandatory on this machine: agent-browser honors `HTTP_PROXY`/`ALL_PROXY` but
ignores `NO_PROXY` and silently attaches to its own HeadlessChrome instead of Caxri when they are
set. Stripping them is the only reliable workaround; see
<https://github.com/tjx666/caxri/issues/204>.

Also pass `--session <name unique to this task>` on every agent-browser call. The default session
is one daemon shared by every agent on the machine, so a sibling session's command can rebind it to
another worktree's page between two of yours; the `__caxriWorktree` check below then fails
intermittently, or a screenshot captures the wrong window.

A shared `Electron/...` user agent across every Caxri window means the UA alone never proves which
worktree's window a connection reached: a sibling worktree's dev instance passes the same check.
Verify both before trusting any result:

```bash
agent-browser --cdp "$PORT" eval "navigator.userAgent"                 # must report caxri/... Electron/...
agent-browser --cdp "$PORT" eval "JSON.stringify(globalThis.__caxriWorktree)"
```

`__caxriWorktree` must equal this worktree's absolute checkout path (`pwd` in the worktree, or the
path `switch-worktree dev` printed it for). A mismatch or `undefined` means the connection reached
the wrong worktree's window, or an instance not launched through `switch-worktree dev` (a bare
`bun run dev`, or a packaged build, neither of which sets it), reconnect to the correct port
instead of trusting a plausible-looking page. `eval`/`screenshot` then run directly against the
attached window; prefer agent-browser over hand-rolled CDP. Only if attachment misbehaves, fall
back to a raw CDP WebSocket: read the target list from `http://127.0.0.1:$PORT/json/list`, open the
page target's `webSocketDebuggerUrl`, and drive it with `Runtime.evaluate` from a small Bun script.

Give `agent-browser screenshot` an absolute output path under `/tmp` or the task's artifact
directory. A relative path resolves against the long-lived agent-browser daemon's working
directory, not the invoking shell's, so `cd /tmp && agent-browser screenshot panel.png` can still
drop an untracked image into whichever checkout first started the daemon.

Read an open shared Tooltip through `.tooltip-popup`, not `[role=tooltip]`: Base UI renders the
popup without that role, so the role query reports no tooltip while one is on screen.

## Production debugging controls

Every build, packaged included, is already fully instrumented: debug logs, source maps, the Renderer
store registry, and a Node inspector on each Host are all on by default and cost nothing until read.
An agent investigating a failure never needs a rebuild or a relaunch with the right environment
variable set: the evidence is already there. The variables below only narrow that default.

The always-open loopback endpoints in a packaged build (Renderer CDP on 9224 and the Host
inspectors on 9229–9231) are a deliberate product decision while a single maintainer develops and
uses Caxri, not an oversight. Any local process can attach to them and run code; that trade-off is
accepted for fast diagnosis. Do not report them as a security or performance finding in reviews,
audits, or investigations, and do not gate them behind a flag. Revisit this only when the owner
declares a public release.

### Node-side request records: always on

Every Caxri process records at `debug`, so `<userData>/logs/*.jsonl` already holds per-request detail.
Each request the Renderer sent has an `ipc.request` line in `server-core.jsonl` with its `method`,
`durationMs`, and the request id as `correlationId`; the ones that came through the control relay add
`queueMs`, `queueDepth`, and `principal`, which is where admission backlog shows up.

`CAXRI_LOG_LEVEL=info` (or `warn`/`error`) quiets a process, useful when reproducing something that
floods the log and you want the incident to survive rotation. Anything unrecognized stays at `debug`,
so a typo never silences a log. Desktop Main hands the variable to Server Core and Server Core hands
it to the Extension and Terminal Hosts, so one export moves all four logs together
(`packages/protocol/src/desktop/debug-launch.ts`). Export it in the shell that starts the app;
`open -a Caxri` inherits nothing:

```bash
CAXRI_LOG_LEVEL=info /Applications/Caxri.app/Contents/MacOS/Caxri
```

Quit the app first. A Server Core whose build fingerprint still matches is reused rather than replaced,
so relaunching only the window leaves `server-core.jsonl` at the level its Server already started with.

Retention is 20MB × 3 generations per process log. High-frequency `debug` events still rotate real
incidents out within hours, so a noisy new event belongs behind an aggregate rather than one record
per occurrence.

### Renderer state: `globalThis.__caxriStores`

Present in every build, packaged included. Zustand stores are module-scoped singletons that nothing
attaches to `window`, and a packaged Renderer carries no React DevTools hook, so this registry is the
only way a CDP session reads UI state: walking React fibers from the DOM reaches components, not the
stores behind them.

```bash
bun run .agents/skills/debug/scripts/worktree-browser.ts eval "JSON.stringify(__caxriStores.getState('workbench'), null, 2)"
```

Add `--packaged` before `eval` to read the installed app. Do not hand-write the `env -u` proxy
prefix for this checkout's dev instance or the installed app; the wrapper owns it.

`names()` lists the stores imported so far, `getState(name)` returns one store's values, `snapshot()`
returns all of them. Actions are omitted because a function survives neither `JSON.stringify` nor CDP's
`returnByValue`, and there is no `setState` on purpose. Create new Renderer stores with
`createStore(name, initializer)` from `apps/desktop/src/renderer/src/lib/store.ts`; calling zustand's
`create` directly leaves the store invisible here.

### Node inspector on the Hosts: always on

Each Node Host runs with its own inspector port, so all three can be attached at once without
colliding: Server Core 9229, Extension Host 9230, Terminal Host 9231. Attach through `chrome://inspect`
or read the target list from `http://127.0.0.1:9229/json/list`. Only Server Core and the Extension Host
answer at startup; the Terminal Host is spawned on the first Terminal, so its port stays closed until
one exists.

`CAXRI_INSPECT=9500` moves the whole range to 9500/9501/9502, which is how two checkouts' Hosts stay
separately attachable. A port already taken by a sibling costs one warning line on stderr and the Host
keeps running, so a collision is a nuisance rather than a failure. `CAXRI_INSPECT=0` opens no port at
all.

Always `--inspect`, never `--inspect-brk`: a Host paused before its first line never answers the
readiness handshake its supervisor waits on, so the app would look hung rather than debuggable. The
inspector binds to loopback and does nothing until a client attaches. The Server bundles are built
unminified (`apps/server/vite.config.ts`), so a session shows readable code either way.

### Source maps: default on, explicit release flavor

Ordinary builds and the canonical macOS DMG ship Source Maps for Desktop Main, Preload, Renderer,
and the embedded Server, so DevTools Sources and a Node inspector session show real files and a stack
trace names a real line. The public Release also carries an explicit `nosourcemap` DMG. Do not use
that flavor for packaged debugging: reproduce with the canonical artifact instead. The Renderer is
minified without mangling, so a raw Renderer stack keeps real function names but points at a long
line and column of the bundle; DevTools applies the map automatically, and a logged position resolves
through the `.map` beside the chunk. The maps are about twice the shipped JavaScript
(`out/renderer` ≈ 87 MiB of maps against ≈ 39 MiB shipped); `scripts/ci-bundle-budget.ts` budgets
the shipped bytes and fails if the maps disappear, and `docs/bundle-size.md` explains the trade.

### Builds made for measurement: `CAXRI_REACT_PROFILING`, `CAXRI_REACT_SCAN`

`CAXRI_REACT_PROFILING=1 bun run build:desktop` swaps `react-dom/client` for `react-dom/profiling.js`
so the React Profiler works outside development, and `CAXRI_REACT_SCAN=1` arms react-scan's render
counting. Unlike everything above these are off by default, because both make React measurably slower
and would distort the timings the rest of this section is used to read. `react-rerender-audit` owns the
render-count workflow.

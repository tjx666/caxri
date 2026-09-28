# Process ownership, runtime profiles, and recovery

For the product-level why behind this topology, see
[Server architecture](../../../../docs/server-architecture.md#server-process-ownership).

```text
Desktop Main
  -> secure BrowserWindow + native dialogs
  -> dedicated Process Explorer window + fixed process sampler
  -> Agent Commander window sharing the Desktop connection behind a Main admission policy
  -> correlated IPC allowlist
  -> authenticated Client with a generation-bound Desktop lease

Standalone Server artifact (pinned runtime)
  -> Server Core process
       -> one profile lock + private loopback WebSocket manifest
       -> command/capability dispatcher + bounded changefeed
       -> Project/Session/File/Git/Agent/Settings/Theme/Diagnostics domains
       -> SQLite through Drizzle ORM
       -> one Terminal Host child
       -> one shared native ESM Extension Host child

Preload
  -> typed request/event bridge only

Renderer
  -> React, xterm.js, Monaco, shadcn/ui on Base UI
  -> separate Process Explorer entry with a snapshot-only preload
  -> separate Agent Commander entry (board + Commander Terminal) on the Workbench preload

Extension Host child process
  -> per-extension generation-scoped public `caxri` API instances
  -> ESM activation, commands, TreeDataProviders, opaque handles, and cancellation

Terminal Host child process
  -> PTY masters, Shell and Agent processes, parsed screens, snapshots, and resource sampling
  -> bounded private protocol available only to Server Core
```

Desktop Main resolves one canonical runtime profile before Chromium startup. That authority supplies
userData, the profile-scoped single-instance lock, the shared process log directory, CDP transport
identity, and the userData path passed to Server. Server derives its endpoint, manifest, and lock
identity from that canonical path. Desktop and CLI validate
`apps/server/dist/server/metadata/manifest.json` in development or
`Contents/Resources/server/metadata/manifest.json` when packaged, then launch the declared pinned
runtime and Server Core entrypoint through `@caxri/client/supervise`.

A second same-profile Desktop exits before attachment and asks the existing Desktop to restore or focus
its window. The typed Desktop lease remains defense in depth for non-Electron Clients and stale-build
recovery. Desktop Main is otherwise replaceable: closing a window revokes its lease and detaches views
without stopping Server Core, Terminal Host, or PTYs. Explicit application quit inspects Server impact:
an idle Server owned only by Desktop stops directly, while live PTYs require a native choice to terminate
tasks, keep them attached in the background, or cancel. A Renderer reload attaches to the same Server
state and bounded Terminal snapshots. A Server Core crash causes its coupled Terminal
Host and live PTYs to be retired; supervision restarts Server Core with capped exponential backoff and
persisted Terminals become `dead`, never silently restored processes. Server Core must remain ready for
30 seconds before its restart budget resets, so ready/crash flapping fails closed after three restarts.

The explicit-quit stop above only covers a clean Desktop exit. A force-killed, crashed, or mid-restart Desktop skips
it entirely, so Server Core also runs an independent idle-exit sweep (`apps/server/src/core/idle-exit.ts`): once the
aggregate authenticated connection count across every transport (Desktop, Mobile, Agent, or CLI) has stayed at zero
continuously for `DEFAULT_IDLE_EXIT_MS` (30 minutes), it exits through the same normal shutdown path — snapshot every
live Terminal, then stop Terminal Host and Extension Host. The sweep never reads the Desktop lease itself; a connected
Desktop's socket is one of the counted transports, so the lease expiring (or the socket dropping for any other
reason) already zeroes that count the same instant. The sweep defers, logging `server_core.idle_exit_deferred` with
the closed reason `active-pty`, whenever `app.health.activePtyCount > 0` or its own health check fails, and rechecks
after another full threshold window — the same live-PTY signal the interactive `host.stop` command requires explicit
confirmation to override, so a Server whose Sessions still own live PTYs never idle-exits on its own;
`switch-worktree`'s `orphans`/`doctor` commands remain the discovery path for that case. A successful exit logs
`server_core.idle_exit_triggered` with the idle duration and how many prior checks deferred. This applies to packaged
builds too — see [ADR 0010](../../../../docs/adr/0010-server-core-idle-exit.md). The threshold is never a
user-facing setting; the only override is the internal `CAXRI_SERVER_IDLE_EXIT_MS` environment seam, forwarded from
Desktop to Server Core in `apps/desktop/src/main/server-connection.ts` the same way as the other `CAXRI_*_MS` dev/test
seams, which `switch-worktree dev` live verification uses to shorten the wait.

One profile owns exactly one Desktop lease. When another Desktop takes it over, Server Core sends an
orderly typed `replaced` revocation before closing the old socket; that Main stops reconnecting and keeps a
persistent notice visible instead of letting two same-profile instances evict each other forever.
Ordinary socket loss remains recoverable. After reconnect, Main re-announces `desktop.ready` and
places one more event recovery command behind it on the same ordered Server Core queue, closing the window
where a durable event could otherwise be journaled after recovery but before live delivery resumed.
Main expresses this behavior through one explicit, pure-tested Desktop↔Server lifecycle state machine:
initial attachment converges to `attached`/`ready`, recoverable loss advances through `backoff`,
`attaching`, and `recovering`, while lease `replaced` and Desktop `disposed` are terminal. Socket,
timer, readiness, and event-recovery I/O remain in the Main facade and cannot introduce parallel
lifecycle flags.

The pre-release reset tool treats Server Core ownership as an operating-system fact, not a discovery-file
claim: dry-run and apply both use `lsof` to bind a live PID to the selected profile's open lock,
verify the fixed artifact Server entrypoint, and recheck ownership immediately before signaling.
It never signals a PID found only in stale or malformed JSON metadata. An explicitly selected
profile may locate its verified orphaned Server endpoint after the profile directory itself has been
removed, while an existing custom profile is still rejected inside a Git worktree or without Caxri
markers. The same plan includes a user-owned stale profile endpoint, deduplicates case variants only
after filesystem identity is known, and discovers only UUID-named managed development profiles
beneath Git's canonical `caxri-worktree-state/profiles` root. Successful targets move into a
timestamped persistent archive under the primary checkout's sibling
`../caxri-uninstall-archives`; its incrementally updated `manifest.json` maps every original path to
its archived path or final failure status. Deriving both locations from Git's canonical common
directory keeps the archive stable when invoked from a linked worktree. Project roots and user
files are never targets.

The Process Explorer is a singleton Desktop Main-owned window with its own Renderer entry and narrow Preload. While open, it samples a fixed `/bin/ps` argv every two seconds, selects both the Desktop and detached Server process trees, overlays Electron process metrics, and exposes only process name, parent/PID, CPU, and resident memory. Common credential flags are redacted before the snapshot crosses IPC. It cannot access the workbench request bridge, Terminal output, environment values, source files, or Agent transcripts; closing it never changes Server or PTY lifecycle.

The Agent Commander is a second singleton Desktop Main-owned window (`agent-commander-window.ts`). Unlike the Process Explorer it loads the Workbench preload and shares Main's single Desktop connection, so Main, not the preload, is its authority boundary: `AgentCommanderRendererPolicy` admits a fixed request list plus Terminal requests naming only the Commander Terminal, and routes relay messages per window (durable envelopes to both, Terminal-scoped transient events to the viewing window, the reconnect and pull-request announcements to both, other transient events to the Workbench only). Closing or reloading it detaches the Commander Terminal view without stopping its PTY; closing the main window closes it first. See `docs/agent-commander.md`.

Renderer or Desktop restart recovers Server-owned state and attaches to live PTYs. Server Core restart
recovers database metadata and persisted snapshots, but operating-system PTYs owned by its retired
Terminal Host are not recoverable in the current lifecycle. Restart attempts are capped and use
exponential backoff; a request that arrives while a crash-triggered Server restart is waiting out its
backoff delay is queued to await that same restart rather than forking early. Startup fails visibly
instead of hanging if Server Core does not become ready within 15 seconds. The frozen public `host.stop`
command is the explicit durable process-shutdown boundary; its legacy method ID is retained to
preserve the A0 command contract, not as an architecture owner name.

A Renderer process crash (`render-process-gone`) reloads the window automatically with backoff (250ms, then 1s, then 4s). After three crashes within a 60-second window, automatic reload stops; Main logs the crash loop and shows a native dialog offering Relaunch or Quit instead of reloading indefinitely. The Process Explorer window runs the same policy, but its terminal state is `destroy()` rather than a dialog.

A Renderer hang (`unresponsive`, and its `responsive` recovery) is observation only. Both windows record the entry at `warn` with a per-window lifetime hang count, and the recovery at `info` with how long the main thread was blocked; a repeat `unresponsive` for one continuous block does not increment the count. A hang never reloads, never consumes the crash-recovery budget, and never reaches either terminal state, because Chromium's ~30s threshold is not tunable and long synchronous work is not by itself a fault.

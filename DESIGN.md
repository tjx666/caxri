# Caxri design

## Product model

A `Session` is Caxri's primary durable object. It owns a user-selected `rootPath`, permanent Terminal records, editor/layout state, Git and file context, and optional Agent metadata. Paths are not identities: stable UUIDs allow multiple Sessions to share one root.

## Process model

```text
Electron Main
  -> secure BrowserWindow + native dialogs
  -> correlated IPC allowlist
  -> utilityProcess Runtime supervisor

Preload
  -> typed request/event bridge only

Renderer
  -> React, xterm.js, Monaco, shadcn/ui on Base UI

Runtime utilityProcess
  -> Session/PTY/File/Git/Agent/Settings/Theme/Diagnostics services
  -> better-sqlite3
```

The Renderer never owns runtime truth. A renderer reload attaches to the existing Runtime and receives current metadata plus bounded snapshots. A Runtime crash invalidates every in-memory PTY; the supervisor restarts with capped exponential backoff and persisted terminals are exposed as `dead`, never as silently restored processes.

## IPC contract

Renderer requests use `{ id, method, params }`; Runtime replies use `{ id, ok, result | error }`; runtime events use `{ event, payload }`. Zod validates all renderer request parameters before forwarding. Main keeps a pending request table with timeouts and request correlation IDs. Runtime output events are batched and bounded before crossing process boundaries.

The preload exposes one `request` method backed by a fixed method union plus `onEvent`. It does not expose `ipcRenderer`, Electron objects, environment data, or generic filesystem/process access.

## Persistence

SQLite runs only in the Runtime and uses WAL, foreign keys, migrations, transactions, and busy timeout. Schema v1 contains:

- `sessions`: identity, root, timestamps, primary terminal, last activity, layout version
- `terminals`: durable identity/position/cwd/title/icon/provider and last process state
- `terminal_snapshots`: versioned bounded VT/text payload with line and byte counts
- `session_state`: open editor tabs, active tab, inspector mode, and layout JSON
- `app_state`: last selected session, window state, active theme, and schema version

Snapshots retain at most 2,000 lines and 2 MiB per Terminal. Output is buffered and persisted on a debounce so SQLite never runs in the PTY data callback. Snapshots are UI restoration data, not proof that a process survived.

## PTY lifecycle and backpressure

Runtime launches only discovered allowlisted programs (`$SHELL`, `claude`, or `codex`) with argv, cwd, and a filtered environment. Switching Sessions detaches views but does not stop PTYs. Renderer output delivery is coalesced; per-terminal queues have a byte ceiling and emit a dropped-output marker when the renderer cannot keep up.

Closing the last macOS window with live PTYs asks whether to keep running, terminate and close, or cancel. `Keep Running` hides all windows while Main and Runtime remain alive. Explicit App Quit terminates PTYs and waits briefly for ordered Runtime shutdown. Persisted processes are marked stopped after a normal quit. Dead terminals remain visible and can be restarted.

## Files and editor

Every file request resolves its candidate path, checks it remains beneath the resolved Session root, rejects symlink escapes, and enforces text/size limits. Directories are lazy-loaded. `@parcel/watcher` uses the native recursive macOS backend, ignores VCS internals and dependency/build caches, coalesces bursts, and watches the active root only.

External disk changes always replace an open buffer, including a dirty buffer. This is a deliberate product choice for agent-driven workflows; the Renderer clears dirty state and shows a non-blocking notice rather than opening a conflict dialog.

## Settings, keybindings, and themes

Global `settings.jsonc`, `keybindings.jsonc`, and theme files live in the application data directory. Services use atomic temporary-file replacement, JSONC/schema validation, last-known-good values, and Parcel Watcher hot reload for these three bounded files. Parse errors retain the prior valid state and report location without including source text in diagnostics.

Themes normalize into one semantic token structure consumed by CSS variables, xterm, and Monaco. Dracula is vendored as the first-run default. Importers support Caxri JSON, one VS Code JSON theme, iTerm2 `.itermcolors` plist, and Warp YAML; unsupported tokens become warnings and missing non-terminal tokens inherit from the active theme.

## Git and Agent adapters

Git operations run via `execFile('git', argv)` with fixed argv constructors and never mutate a repository. Adapters discover Claude Code and Codex through the GUI environment plus a login-shell PATH fallback. Local agent state is read-only and capability-detected. Missing or changed storage produces `unknown`; it never interrupts PTY input/output.

## Security

BrowserWindows use `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, a restrictive CSP, blocked navigation, and denied new windows. External HTTP(S) URLs require explicit user intent before Main uses the system browser. No telemetry or remote upload exists.

## Performance and observability

Main and Runtime record boundary timings for app readiness, Runtime attachment, first window visibility, Runtime boot, PTY spawn, file listing, Git commands, Agent probes, and watcher readiness. Concurrent identical file, Git, Agent, and Terminal-start requests share one in-flight operation so development StrictMode and repeated UI requests do not duplicate native work.

Terminal input, resize, and output are high-frequency paths. Successful input and resize requests do not write individual records; PTY throughput is emitted as periodic aggregate input, output, and dropped-byte counters. Monaco and its workers load only when an editor is opened, keeping them out of the terminal-first Renderer bundle.

`benchmark:startup` exercises a representative large repository and requires Runtime, Terminal, Files, and Git to become usable within three seconds. It also validates timed log coverage, zero request/watcher failures, aggregated terminal metrics, and fewer than 256 Runtime file descriptors.

## Diagnostics and privacy

Structured logs carry timestamp, process, level, event, correlation ID, and duration. Diagnostics contain application/runtime versions, redacted metadata/state, counts, and timing summaries. Home paths normalize to `$HOME`; keys matching token/password/secret/credential/API-key patterns are redacted. Bundles never include file contents, terminal output/snapshots, environment values, prompts/responses, or agent transcripts.

Development launches write Main and Runtime JSONL files to the repository `logs/` directory for direct inspection. Packaged and test launches keep logs beneath the active Electron user-data directory so application data remains self-contained.

## Recovery limits

Renderer reload recovers UI state and attaches to live PTYs. Runtime restart recovers database metadata and snapshots only; operating-system PTYs owned by the dead Runtime are not recoverable. Restart attempts are capped and use exponential backoff. App exit is the only supported durable process boundary; PTYs do not outlive an explicit quit.

# Caxri architecture

## Product model

A `Project` is a user-selected local folder and the durable owner of its `rootPath`, file tree, Git context, and path-security grant. A `Session` belongs to one Project and owns permanent Terminal records, editor/layout state, and optional Agent metadata. The first Agent Terminal in a Session is its title source; Shell-only Sessions keep their Shell title. Multiple Sessions can share one Project without duplicating its directory identity.

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
  -> Project/Session/PTY/File/Git/Agent/Settings/Theme/Diagnostics services
  -> better-sqlite3
```

The Renderer never owns runtime truth. A renderer reload attaches to the existing Runtime and receives current metadata plus bounded snapshots. A Runtime crash invalidates every in-memory PTY; the supervisor restarts with capped exponential backoff and persisted terminals are exposed as `dead`, never as silently restored processes. A Runtime must remain ready for 30 seconds before its restart budget resets, so ready/crash flapping still fails closed after three restarts.

## IPC contract

Renderer requests use `{ id, method, params }`; Runtime replies use `{ id, ok, result | error }`; runtime events use `{ event, payload }`. `src/shared/ipc` holds one method table that pairs every method name with its owner (`main` or `runtime`), a Zod params schema, and a Zod result schema; domain types, the runtime event union, and the terminal split layout are Zod schemas in the same module, so both processes and the Renderer infer their types from a single declaration. Internal methods live in a separate table that the Renderer envelope rejects. Zod validates all renderer request parameters before forwarding. Main keeps a pending request table with timeouts and request correlation IDs. Runtime output events are batched and bounded before crossing process boundaries.

The Runtime resolves that table through one composition root. `createRuntime(deps)` constructs and wires every service from injected dependencies (data directory, logger, event sink, and PTY/Agent seams) and returns an exhaustive handler table plus a single disposal path, so the entry point only connects the parent port and the whole request surface is exercisable in-process without Electron. One dispatcher validates each request, invokes its handler, records the request boundary, and classifies failures.

Failures carry a closed error code (`VALIDATION`, `NOT_FOUND`, `PATH_DENIED`, `CAPACITY`, `UNAVAILABLE`, `TIMEOUT`, `CONFLICT`, `IO`, `GIT`, `INTERNAL`). Runtime and Main encode a `CaxriError` into the wire reply, and the supervisor and preload rebuild it on the other side, so a code survives every process hop instead of degrading into an opaque message. Unrecognized codes decay to `INTERNAL`, and only `INTERNAL` failures log a stack.

The preload exposes one `request` method backed by a fixed method union plus `onEvent`. It does not expose `ipcRenderer`, Electron objects, environment data, or generic filesystem/process access. Main starts the Runtime with an allowlisted environment containing only process-launch context, tool state locations, and Caxri-owned paths; ambient credential variables are not copied into the utility process.

## Persistence

SQLite runs only in the Runtime and uses WAL, foreign keys, transactions, and busy timeout. Schema v5 contains:

- `projects`: identity, unique root, display title, and timestamps
- `sessions`: Project ownership, identity, timestamps, primary Agent Terminal, last activity, layout version
- `terminals`: durable identity/position/cwd/title/icon/provider and last process state
- `terminal_snapshots`: versioned bounded VT/text payload with line and byte counts
- `session_state`: open editor tabs, active tab, inspector mode, and a recursive Terminal split layout
- `app_state`: last selected Project and Session, window state, active theme, and schema version

Snapshots retain at most 2,000 lines and 2 MiB per Terminal. Output is appended to chunk buffers and compacted on a debounce so the PTY data callback neither rescans the full snapshot nor writes SQLite. A Renderer subscribes before attaching, then replays the bounded snapshot ahead of output received during attachment. Bytes already represented by that snapshot are removed from the live-output queue before replay to prevent duplication. Detached Terminals retain bounded snapshots without broadcasting output to an invisible view. Snapshots are UI restoration data, not proof that a process survived.

## PTY lifecycle and backpressure

Runtime launches only discovered allowlisted programs (`$SHELL`, `claude`, or `codex`) with argv, cwd, and a filtered environment. Shell context plus standard proxy and custom-CA variables are retained, while credential-bearing and Caxri-internal variables are excluded. Switching Sessions detaches views but does not stop PTYs. Renderer output delivery is coalesced; per-terminal queues have a byte ceiling and emit a dropped-output marker when the renderer cannot keep up. Durable Terminal creation is capped at 16 per Session and 32 globally. The Renderer bundles JetBrains Mono's four terminal faces plus Symbols Nerd Font Mono as a fallback and loads them before xterm measures its cells, so packaged builds do not depend on system-installed terminal fonts.

Terminal groups form a persisted binary split tree with horizontal or vertical direction and a bounded ratio. Dragging a tab moves its durable Terminal ID between groups or creates a new split; shared reducers collapse empty groups and validate that one Terminal cannot appear twice. Moving a view may detach and reattach xterm, but the Runtime-owned PTY is neither restarted nor duplicated. Keyboard-adjustable separators and group labels preserve accessible focus semantics.

Default `Command+K`, `Command+T`, and `Command+W` bindings clear the active xterm view, create a Terminal in the active group, and close the active Terminal through its normal lifecycle. Clear is Renderer-local and never sends input or a signal to the PTY. All bindings remain configurable, and app-wide commands are ignored while a modal dialog is open.

Closing the last macOS window with live PTYs asks whether to keep running, terminate and close, or cancel. `Keep Running` detaches every Renderer view and closes the window while Main, Runtime, and PTYs remain alive; reopening creates a new window and attaches it to the live Runtime. Explicit App Quit terminates PTYs and waits briefly for ordered Runtime shutdown. Persisted processes are marked stopped after a normal quit. Dead terminals remain visible and can be restarted. In-flight Agent CLI discovery is revalidated against durable metadata before a PTY is registered, so closing a Terminal or deleting its Session cannot create an orphan process.

Exited Terminals retain their final output and reserve a compact recovery row beneath the xterm viewport, never over it. A zero exit without a signal is neutral; startup failures and signal or non-zero exits use a danger state. Surface actions, the command palette, and `Command+Shift+R` restart the same durable Terminal record, so recovery cannot create a duplicate tab or PTY identity.

## Files and editor

The Files inspector resolves a curated, deterministic subset of local LobeHub file icons by exact filename, well-known directory, test suffix, and extension before falling back to generic file and folder assets. Expanded directories use matching open variants. Vite emits only the explicitly imported SVG subset as separate assets, so icons remain offline-capable without embedding the full upstream catalog in the initial Renderer JavaScript bundle.

Agent identity is a Renderer-wide typed registry rather than a per-surface icon choice. Terminal tabs, Project Session rows, creation choices, Terminal Info cards, and Settings resolve the same Claude Code, Codex, Shell, reserved Grok/OpenCode, or unknown identity. Brand SVGs are emitted as local build assets; monochrome icons inherit the active theme, and unsupported future adapters use a deliberate generic fallback. The Info inspector lists only Terminals owned by the selected Session, including their process state, PID when live, directory, and correlated Agent session ID; installed tools that were not started in that Session never appear there.

Every file request resolves its candidate path, obtains the authoritative root from the Session's Project, checks the candidate remains beneath that resolved Project root, rejects symlink escapes, and enforces text/size limits. Saves open the validated inode with `O_NOFOLLOW` before truncation. Directory identity is revalidated around enumeration so a path swap cannot disclose another directory. Directories are lazy-loaded. `@parcel/watcher` uses the native recursive macOS backend, ignores VCS internals and dependency/build caches, coalesces bursts, and watches the active root only. A bounded fallback polls only the active root and directories already expanded by the user, preserving external-change delivery when the native backend is unavailable or silent. Watcher refreshes reload entries without remounting the tree, while switching Session identity intentionally resets expanded absolute paths.

External disk changes always replace an open buffer, including a dirty buffer. This is a deliberate product choice for agent-driven workflows; the Renderer clears dirty state and shows a non-blocking notice rather than opening a conflict dialog. Editor buffers and Monaco model URIs are keyed by Session identity as well as path so Sessions sharing one root cannot reuse each other's dirty state. When a Session becomes active again, cached documents are compared with current disk version metadata; only actual disk changes replace its inactive dirty buffers.

Git file selections open read-only virtual editor tabs instead of embedding patch text in the Inspector. A single-file tab renders a Monaco side-by-side diff; a repository `Open Changes` tab renders its changed files as one scrollable multi-diff surface. Multi-diff rows load their bounded document and mount Monaco only near the viewport; a binary or transient per-file failure remains local to that row. The virtual tab key persists the opaque repository ID and repository-relative path so reload can reconstruct the diff without treating it as a writable filesystem document.

## Settings, keybindings, and themes

Global `settings.jsonc`, `keybindings.jsonc`, and theme files live in the application data directory. Writes sync a mode-`0600` temporary file before atomic replacement, and in-memory state changes only after replacement succeeds. The Runtime prefers Parcel Watcher hot reload and falls back to polling only these three bounded files. Startup and hot-reload changes are schema-validated before replacing in-memory state; parse errors retain defaults or the prior valid state and report location without including source text in diagnostics.

Themes normalize into one semantic token structure consumed by CSS variables, xterm, and Monaco. Dracula is vendored as the first-run default. Importers support Caxri JSON, one VS Code JSON theme, iTerm2 `.itermcolors` plist, and Warp YAML; unsupported tokens become warnings and missing non-terminal tokens inherit from the active theme.

## Git and Agent adapters

Git operations run via `execFile('git', argv)` with fixed argv constructors, a filtered environment, and no repository mutation. Adapters discover Claude Code and Codex independently through the GUI environment plus a login-shell PATH fallback. Claude Code integration reads only compact live-session metadata. Codex integration locates state beneath the documented `CODEX_HOME`/`CODEX_SQLITE_HOME` roots and queries a capability-detected thread index read-only; neither adapter opens transcripts. Available title, session ID, activity, and usage metadata are correlated with the matching provider Terminal. A provider-owned Agent session ID may be claimed by only one Terminal; unbound probes exclude IDs already claimed by another Terminal and IDs discarded by a restart. The first Agent Terminal becomes the Session's primary Agent Terminal and exclusively owns the sidebar title; later Agent Terminals retain independent metadata without replacing it. Closing the primary promotes the next Agent Terminal. Missing or changed storage produces `unknown`; it never interrupts PTY input/output or resets a known Session title.

A Shell Terminal can become an Agent Terminal when its unpublished input line directly launches `claude` or `codex`. Runtime keeps that command candidate in memory for a bounded window and promotes the durable Terminal atomically only after the matching provider writes a new, same-Project, unclaimed metadata session created after command submission. Shell input is never logged or persisted; aliases, compound shell commands, and ordinary process output do not infer Agent identity.

The Git inspector treats the selected Project repository, linked worktrees, nested repositories, and initialized submodules as independent status scopes. Repository discovery uses structured Git output, coalesces concurrent summaries, and passes an opaque repository ID back for diff requests. `git.diffDocument` returns bounded original and working-tree text for Monaco without exposing an arbitrary Git command or weakening repository containment. Nested roots inherit the containing Project grant. A linked worktree outside that root appears only after its directory has independently been added as a Project; Git discovery never expands durable path authority.

The Project Status inspector is lazy: opening its tab asks Runtime to combine the approved primary repository and initialized submodules with GitHub PR/check data, deliberate Linear references from the PR body, and Vercel deployments. The always-visible Status Bar uses a separate lightweight primary-repository overview: it reads Git changes plus the origin and current GitHub PR, never triggering Linear or Vercel, and file events refresh only `git.summary`. Runtime invokes `gh`, `linear`, and `vc` only through structured argv arrays, filtered environment inheritance, timeouts, and bounded output; Renderer receives validated read models and never CLI access. Missing tools, authentication, links, rate limits, and timeouts stay scoped to the relevant surface, while external HTTP(S) links still pass through Main's confirmation boundary.

## Security

BrowserWindows use `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, a restrictive CSP, blocked navigation, and denied new windows. External HTTP(S) URLs require explicit user intent before Main uses the system browser. No telemetry or remote upload exists.

Directory-picker results create single-use Main-process grants. A grant is revoked when the Agent choice is canceled, expires after 60 seconds if unused, and is consumed before Project creation reaches the Runtime. Once a Project exists, new Sessions reference its stable ID and cannot submit or broaden a root path.

## Performance and observability

Main and Runtime record boundary timings for app readiness, Runtime attachment, first window visibility, Runtime boot, PTY spawn, file listing, Git commands, Agent probes, and watcher readiness. Concurrent identical file, Git, Agent, and Terminal-start requests share one in-flight operation so development StrictMode and repeated UI requests do not duplicate native work. Agent Terminal output schedules a trailing metadata refresh with at most one timer per Terminal, allowing a CLI-generated title to reach the sidebar without opening the Info inspector. One Agent coordinator owns that scheduling and reads Agent Terminal membership from the durable Terminal record instead of a cached set, so no lifecycle path can leave the two disagreeing. Ordinary Shell and dev-server output never enters this probe path; only a bounded direct-Agent command candidate may request provider confirmation.

Terminal input, resize, and output are high-frequency paths. Successful input and resize requests do not write individual records; PTY throughput is emitted as periodic aggregate input, output, and dropped-byte counters. Monaco and its workers load only when an editor is opened, keeping them out of the terminal-first Renderer bundle.

`benchmark:startup` exercises a representative large repository and requires Runtime, Terminal, Files, and Git to become usable within three seconds. It also validates timed log coverage, zero request/watcher failures, aggregated terminal metrics, and fewer than 256 Runtime file descriptors.

## Diagnostics and privacy

Structured logs carry timestamp, process, level, event, correlation ID, duration, and the build's application version and commit when known. Diagnostics contain application/runtime versions, redacted metadata/state, counts, and timing summaries. Home paths normalize to `$HOME`; secret-like keys, bearer/API tokens, GitHub tokens, and Slack tokens are redacted. Bundles never include file contents, terminal output/snapshots, environment values, prompts/responses, or agent transcripts.

The application version and short commit hash are injected at build time and read once by Main, which stamps its own logs and forwards them to the Runtime's environment so both processes' logs and the diagnostics export can be correlated to the exact build.

Development launches write Main and Runtime JSONL files to the repository `logs/` directory for direct inspection. Packaged and test launches keep logs beneath the active Electron user-data directory so application data remains self-contained.

## Recovery limits

Renderer reload recovers UI state and attaches to live PTYs. Runtime restart recovers database metadata and snapshots only; operating-system PTYs owned by the dead Runtime are not recoverable. Restart attempts are capped and use exponential backoff; a Renderer request that arrives while a crash-triggered restart is waiting out its backoff delay is queued to await that same restart rather than forking early. Startup fails visibly instead of hanging if no Runtime becomes ready within 15 seconds. App exit is the only supported durable process boundary; PTYs do not outlive an explicit quit.

A Renderer process crash (`render-process-gone`) reloads the window automatically with backoff (250ms, then 1s, then 4s). After three crashes within a 60-second window, automatic reload stops; Main logs the crash loop and shows a native dialog offering Relaunch or Quit instead of reloading indefinitely.

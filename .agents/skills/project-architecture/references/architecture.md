# Caxri architecture

## Product model

A `Project` is a user-authorized local folder and the durable owner of its `rootPath`, explicit Sidebar order, and path-security grant. A `Session` belongs permanently to one owning Project and owns permanent Terminal records, root-scoped Workbench state, layout, and optional Agent metadata. Its independently persisted `Workbench Root` selects the authorized Project used by Files, Editor, Search, and Git; it defaults and falls back to the owning Project, while Terminal cwd, Agent launches, Agent Endpoint ownership, Sidebar grouping, and Session identity never move. Workbench navigation and dirty document identity use the tuple `(sessionId, workbenchProjectId, path)`, so switching roots restores independent tabs, selection, Git mode, and dirty buffers without merging same-named paths. See [ADR 0001](../../../../docs/adr/0001-separate-session-owner-and-workbench-root.md).

Session identity isolates Renderer editor, layout, inspector, and navigation state. Every new
Session-scoped state surface must key or reset that state when the selected Session changes.

Archiving a Session hides it from active navigation without stopping or deleting its Terminals, and restore only clears that metadata. The Sidebar keeps one global Archived Sessions entry even when its count is zero; a Renderer-only management dialog derives search, Project/Agent filters, Project grouping, and newest-first order from the existing bootstrap snapshot, then delegates restore and delete to the unchanged structured Session methods. Every new Session starts with the automatic title `Untitled`, while its initial Terminal keeps the provider-specific title. The first Agent Terminal becomes the source of later automatic title promotion from useful metadata; a user rename switches the title to manual ownership so later Agent metadata cannot replace it. Multiple Sessions can share one Project without duplicating its directory identity.

Project and Session deletion removes Caxri metadata only. It never removes the authorized Project
directory or user files.

## Process model

```text
Electron Main
  -> secure BrowserWindow + native dialogs
  -> dedicated Process Explorer window + fixed process sampler
  -> correlated IPC allowlist
  -> authenticated Desktop client with a generation-bound Host lease

Headless Host (Electron RunAsNode)
  -> one profile lock + private Unix socket
  -> command/capability dispatcher + bounded event journal
  -> in-memory generation-scoped Agent Endpoint registry + bounded Peer Inbox
  -> one Node-mode Runtime child

Preload
  -> typed request/event bridge only

Renderer
  -> React, xterm.js, Monaco, shadcn/ui on Base UI
  -> separate Process Explorer entry with a snapshot-only preload

Runtime child process
  -> Project/Session/PTY/File/Git/Agent/Settings/Theme/Diagnostics services
  -> better-sqlite3 through Drizzle ORM
```

The Host is the profile authority and sole Runtime/SQLite owner. Electron Main is a replaceable
Desktop client: closing a window or quitting Desktop revokes its lease and detaches views without
stopping Host, Runtime, or PTYs. A renderer reload attaches to the same Runtime state and bounded
snapshots. A Runtime crash invalidates every in-memory PTY; the Host restarts it with capped
exponential backoff and persisted terminals are exposed as `dead`, never as silently restored
processes. A Runtime must remain ready for 30 seconds before its restart budget resets, so
ready/crash flapping still fails closed after three restarts.

One profile owns exactly one Desktop lease. When another Desktop takes it over, Host sends an
orderly typed `replaced` revocation before closing the old socket; that Main stops reconnecting and keeps a
persistent notice visible instead of letting two same-profile instances evict each other forever.
Ordinary socket loss remains recoverable. After reconnect, Main re-announces `desktop.ready` and
places one more event recovery command behind it on the same ordered Host queue, closing the window
where a durable event could otherwise be journaled after recovery but before live delivery resumed.
Main expresses this behavior through one explicit, pure-tested Desktop↔Host lifecycle state machine:
initial attachment converges to `attached`/`ready`, recoverable loss advances through `backoff`,
`attaching`, and `recovering`, while lease `replaced` and Desktop `disposed` are terminal. Socket,
timer, readiness, and event-recovery I/O remain in the Main facade and cannot introduce parallel
lifecycle flags.

The pre-release reset tool treats Host ownership as an operating-system fact, not a discovery-file
claim: dry-run and apply both use `lsof` to bind a live PID to the selected profile's open lock or
Unix endpoint, verify the fixed Host entrypoint, and recheck ownership immediately before signaling.
It never signals a PID found only in stale or malformed JSON metadata. An explicitly selected
profile may locate its verified orphaned Host endpoint after the profile directory itself has been
removed, while an existing custom profile is still rejected inside a Git worktree or without Caxri
markers. The same plan includes a user-owned stale profile endpoint, deduplicates case variants only
after filesystem identity is known, and discovers only UUID-named managed development profiles
beneath Git's canonical `caxri-worktree-state/profiles` root. Successful targets move into a
timestamped persistent archive under the primary checkout's sibling
`../caxri-uninstall-archives`; its incrementally updated `manifest.json` maps every original path to
its archived path or final failure status. Deriving both locations from Git's canonical common
directory keeps the archive stable when invoked from a linked worktree. Project roots and user
files are never targets.

The Process Explorer is a singleton Main-owned window with its own renderer entry and narrow preload. While open, it samples a fixed `/bin/ps` argv every two seconds, selects both the Desktop and detached Host process trees, overlays Electron process metrics, and exposes only process name, parent/PID, CPU, and resident memory. Common credential flags are redacted before the snapshot crosses IPC. It cannot access the workbench request bridge, Terminal output, environment values, source files, or Agent transcripts; closing it never changes Runtime or PTY lifecycle.

## IPC contract

`packages/protocol` is the browser-safe, transport-neutral source of truth for command and event
contracts. A command request uses `{ protocolVersion, id, method, params }`; every method declares
one owner (`host` or `desktop`), effect (`read`, `write`, or `control`), required capabilities,
idempotency policy, Zod parameter/result schemas, and an optional principal projection. The
negotiation welcome identifies the authenticated principal and enumerates granted capabilities and
supported commands, so callers can query support without inferring it from errors. Desktop bridge
imports continue through `src/shared/ipc` compatibility re-exports, but that directory must not
define a second method or schema table. Protocol source is grouped behind six domain barrels:
`agent`, `configuration`, `desktop`, `domain`, `registry`, and `transport`; the package root is the
only public package entrypoint.

The shared dispatcher validates protocol version, command, parameters, principal, capabilities,
owner availability, and results before it returns `{ protocolVersion, ok, result | error }`. Read
commands may execute again; write and control commands coalesce the same principal/request ID and
reject an ID reused with different command content. The Electron adapter additionally validates the
requesting WebContents before invoking that dispatcher. Internal Runtime methods remain outside the
public command registry.

`packages/cli` is the Node-only adapter for the same registry and authenticated Host transport.
Source is grouped behind `commands`, `host`, and `skills` domain barrels; the package root remains
the composition root and the only public package entrypoint. Domain barrels stay thin, and tests
live in domain-local `__tests__/` directories. The offline `capabilities` response serializes the
registry's Zod parameter and result schemas together with owner, effect, capability, and
idempotency metadata. Human TTY, JSON, and ID-only output modes share closed error codes;
Agent and CI contexts default to JSON and never prompt. A mutation requires
an explicit profile plus any command-specific Project, Session, or Terminal selector and cannot
infer a target from uniqueness. The CLI may discover the private Host manifest and connect through
its local socket, but it cannot read Runtime persistence, logs, configuration files, or Desktop IPC.
The CLI derives its executable and Host entry only when the current RunAsNode process, resources
directory, and script path match the immutable packaged application layout; no environment variable
can nominate a process to spawn. Human commands may adopt or start one detached Host, while Agent and
CI commands only connect to an already-running Host and Agent Endpoint credentials remain bound to
their generation. The local JSON-line decoder is shared by Host and CLI, incrementally bounds frames
large enough for configured editor and diff payloads, and never repeatedly copies an incomplete
frame. Authenticated Desktop lease renewals bypass the ordered business-command queue so a bounded
long-running file operation cannot expire the active Desktop generation.
Top-level `open|reveal` submit only one bounded path and optional Session ID to the Host; Runtime
revalidates Project containment and Host replaces that path with a one-use, generation-bound opaque
target before Desktop Main can open or reveal it. CLI retries use the shared request-ID idempotency
contract and never call Electron, Finder, or a shell directly.
For a directly managed Agent PTY, Runtime requests a separate Endpoint credential over correlated
private child IPC immediately before spawn. Host stores only its digest and fences every command by
Host, Endpoint, generation, and launch identity; restart, exit, close, deletion, Runtime crash, and
expiry revoke it. The inherited Agent credential supplies same-Project read capabilities by default,
while bounded generation grants add debug, business-write, or Agent-control capabilities. A Shell
promotion never receives an Endpoint. These bearer capabilities are a product authorization boundary,
not a sandbox from same-user code that can independently read the private owner manifest.

The canonical provider-neutral Agent guide lives at `skills/caxri-cli/SKILL.md`. The CLI build
validates its executable examples and capability marker against the same command registry, then
embeds the exact skill files in the standalone artifact with CLI/protocol compatibility metadata and
a content hash. Offline `skills list|get|status` never opens the Host transport or emits local paths.
Explicit install/update operations target only the documented Project-local or user-global skill
directory for the selected Codex or Claude provider. A complete immutable release is written beside
the Provider-visible entry before one relative directory symlink publishes it; update atomically
switches that symlink, so a loader sees either complete version. Mutations anchor themselves to the
verified parent inode, mark and bound the managed release tree, preserve sibling and unmarked
entries, and fail closed for modified, unknown-schema, or newer installations; removal applies only
to intact current or older marked entries. Neither provider exposes a stable, documented per-Session
skill injection boundary in the controlled version matrix, so Caxri reports local installation
instead of altering Provider launch flags or private state.

Runtime output events are batched and bounded before crossing process boundaries. Host owns the durable
structural events use a monotonic, bounded cursor journal: a reconnect receives an intact suffix or
a bounded ID/revision snapshot when its cursor has fallen behind. Terminal output never enters that
journal; one-shot Desktop commands are transient too. Main keeps a second local journal only for
Renderer reloads. Terminal output retains its specialized attachment, snapshot, and backpressure path. Structural state
changes request the full bootstrap convergence snapshot; steady-state Terminal and Agent metadata
events carry typed Session/Terminal identities and use the bounded `app.records` read so they never
resend the whole application graph. An unrecognized state-change scope normalizes to the full
convergence path.

The Runtime resolves that table through one composition root. `createRuntime(deps)` constructs and wires every service from injected dependencies (data directory, logger, event sink, and PTY/Agent seams) and returns an exhaustive handler table plus a single disposal path, so the entry point only connects the parent port and the whole request surface is exercisable in-process without Electron. One dispatcher validates each request, invokes its handler, records the request boundary, and classifies failures.

Runtime module placement follows one scale rule: a domain may remain flat while it has at most two production modules; at three or more cohesive modules it owns `src/runtime/<domain>/`, exposes its boundary through `index.ts`, and keeps its tests in that directory's `__tests__/`. Git, Terminal, Agents, Files, and DB use this nested shape. Production cross-domain Runtime imports stay relative and target only the domain root; a focused structure test rejects a missing barrel or deep cross-domain import.

Failures carry a closed error code (`VALIDATION`, `FORBIDDEN`, `NOT_FOUND`, `PATH_DENIED`, `CAPACITY`, `UNAVAILABLE`, `TIMEOUT`, `CONFLICT`, `IO`, `GIT`, `INTERNAL`). Runtime and Main encode a `CaxriError` into the wire reply, and the supervisor and preload rebuild it on the other side, so a code survives every process hop instead of degrading into an opaque message. Unrecognized codes decay to `INTERNAL`, and only `INTERNAL` failures log a stack.

The workbench preload exposes one `request` method backed by a fixed method union plus `onEvent` and
a content-free `reportError` classifier. The Process Explorer preload has the same error classifier
beside its read-only snapshot/theme methods. Renderer entries report only `page-exception` or
`unhandled-rejection`; exception values never cross the bridge. Main validates both the sender and
kind, then writes stable structured events. The preload does not expose `ipcRenderer`, Electron
objects, environment data, or generic filesystem/process access. Host, Main, and Runtime observe fatal
Node errors through `uncaughtExceptionMonitor`, which preserves their existing crash/exit behavior,
and use a bounded early-startup buffer plus a synchronous bootstrap logger. Host starts the Runtime
with an allowlisted environment containing only process-launch context, tool state locations, and
Caxri-owned paths; ambient credential variables are not copied into either child process.

Every Electron Playwright spec uses `e2e/support/fixtures.ts`. `launchCaxriApp` registers each application
with that automatic fixture, which observes all Renderer pages, captures Host, Main, and Runtime
logs before profile cleanup, stops the isolated Host on the final launch, and fails on any
undeclared error/fatal event. Intentional faults use exact
source/event/code/count allowances; unconsumed allowances fail so repaired faults cannot leave stale
suppression behind.

## Persistence

SQLite runs only in the Runtime and uses WAL, foreign keys, transactions, and busy timeout. Table definitions live declaratively in `src/runtime/db/schema.ts` (Drizzle ORM); `bunx --bun drizzle-kit generate` emits the checked-in SQL under `src/runtime/db/migrations/`, which the Runtime bundles via the validated `migrations/manifest.ts` `?raw` imports so packaged builds never read migration files from disk. After any schema change, regenerate with drizzle-kit, then add the generated migration to that manifest — never hand-edit the migrations directory. The manifest must match the Drizzle journal exactly and derives `user_version` from the schema 7 preservation floor plus every later migration. Older experimental databases may still be rebuilt, but schema 7 and every later version advance transactionally without deleting Projects, Sessions, Terminals, snapshots, selection, or layout state. Database composition writes the same derived version to `app_state.schemaVersion`. Caxri's public data-compatibility commitment begins with v1.0.0, backed by that preserved chain; adding a schema version requires both generated SQL and an N-1 upgrade test. Query modules use the Drizzle query builder while the raw better-sqlite3 handle remains for pragmas and transactions. The schema contains:

- `projects`: identity, unique root, display title, explicit Sidebar order, and timestamps
- `sessions`: Project ownership, identity, timestamps, reversible archive time, primary Agent Terminal, last activity, layout version, and automatic/manual title ownership
- `terminals`: durable identity/position/cwd/title/icon/provider and last process state
- `terminal_snapshots`: versioned bounded VT/text payload with source grid, line, and byte counts
- `session_state`: versioned open editor tabs, active tab, inspector mode, recursive Terminal split layout, and the last durable file-mutation editor-remap operation ID so at-least-once recovery stays idempotent across Renderer reloads; invalid JSON, invalid shapes, or unsupported versions repair to a default layout and emit a content-free warning instead of failing bootstrap
- `app_state`: last selected Project and Session, window state, active theme, and schema version

Snapshots retain at most 2,000 lines and 2 MiB per Terminal. Each live PTY owns a Runtime-side headless xterm screen whose ordered write and resize queue preserves cursor-addressed state. A live attach first moves that screen and PTY to the receiving Renderer grid, then crosses an exact queue barrier and replays a bounded serialized screen before later output. A Renderer subscribes before attaching, then replays that bounded snapshot ahead of output received during attachment. Bytes already represented by that snapshot are removed from the live-output queue before replay to prevent duplication. Detached Terminals retain the parsed screen in memory without broadcasting output to an invisible view. Exit, restart, and orderly or terminate shutdown persist that same parsed screen plus its exact source grid as encoding 3 after excluding interaction modes; raw PTY bytes are never durable recovery data. Renderer recovery disconnects normal resize observation, restores the serialized framebuffer at that source grid, waits for xterm parsing and buffered output to finish, then fits once to the current pane and resumes observation. Older, malformed, or unknown encodings fail closed and restore an empty screen. An unclean Runtime loss can therefore lose the current generation's latest visual history instead of replaying unsafe raw input. Snapshots are UI restoration data, not proof that a process survived.

## PTY lifecycle and backpressure

Runtime launches only discovered allowlisted programs (`$SHELL` or a registered Agent provider) with structured argv, a persisted cwd, and a filtered environment. Each provider owns bounded launch executable/argument settings; configured initial args precede provider-owned resume args. Agent executables use a cached, bounded login-shell PATH shared with version probes, while normal Shell Terminals retain their existing login-shell startup. Standard proxy and custom-CA variables are retained, while unrelated credentials and Caxri-internal variables are excluded. Main forwards a narrow E2E-only Agent policy to Runtime: default launches block every provider, fake mode maps declared providers to absolute fixture executables, and real mode permits production discovery for exactly one provider. Terminal launches and metadata/version probes share that policy; isolated login profiles also prepend generated fake-or-blocked shims so typing a provider name in a Shell cannot fall through to a host CLI. Real mode accepts only the Codex `exec` smoke's fixed ephemeral/read-only argv plus one bounded natural prompt, rejects later Terminal input, and refuses Shell launches entirely, leaving interactive and control-byte coverage to fake mode. When at least one provider lifecycle integration is enabled, Terminal Manager adds only an opaque PTY generation, local socket path, and random authentication token immediately before spawn; it revokes that generation before restart, exit, or close. A new Terminal resolves the global default cwd (`~` supported) or falls back to its Project root before its durable record is inserted; restarts always reuse that record, and Files/Git authorization remains anchored to the Project root. Switching Sessions detaches views but does not stop PTYs. Renderer output delivery is coalesced; per-terminal queues have a byte ceiling and emit a dropped-output marker when the renderer cannot keep up. Durable Terminal creation is capped at 16 per Session and 32 globally. The Renderer bundles JetBrains Mono's four terminal faces plus Symbols Nerd Font Mono as a fallback and loads them before xterm measures its cells, so packaged builds do not depend on system-installed terminal fonts.

Terminal groups form a persisted binary split tree with horizontal or vertical direction and a bounded ratio. Dragging a tab moves its durable Terminal ID between groups or creates a new split; shared reducers collapse empty groups and validate that one Terminal cannot appear twice. Moving a view may detach and reattach xterm, but the Runtime-owned PTY is neither restarted nor duplicated. Keyboard-adjustable separators and group labels preserve accessible focus semantics.

The active Terminal's Status Bar metrics remain Runtime-owned. A fixed `ps` argv samples only PID, PPID, and RSS for the live PTY process tree every two seconds while that Terminal is visible; the Renderer receives aggregate memory and descendant count, never commands or environment data. Sampling stops when a file tab is active and an exited PTY returns no usage.

Default `Command+K`, `Command+T`, and `Command+W` bindings clear the active xterm view, create a Terminal in the active group, and close the active Terminal through its normal lifecycle. Clear is Renderer-local and never sends input or a signal to the PTY. All bindings remain configurable, and app-wide commands are ignored while a modal dialog is open. Command-backed native menu items derive placement, ordering, labels, and accelerators from the shared command catalog and live keybindings; only standard Electron role items stay explicit in Main. Inspector modes register their schema value, show command, catalog metadata, and default binding once in `src/shared/inspector.ts`; the Renderer panel map remains exhaustive and type-checks each mode against its derived command id.

Closing the last macOS window with live PTYs asks whether to keep running, terminate and close, or cancel. `Keep Running` detaches every Renderer view and closes the window while Host, Runtime, and PTYs remain alive; reopening creates a new window and attaches it to the live Runtime. `Quit Caxri Desktop` persists window state, detaches views, and disconnects Main, but only the explicit `host stop` control terminates PTYs and shuts down Runtime. Dead terminals remain visible and can be restarted. In-flight Agent CLI discovery is revalidated against durable metadata before a PTY is registered, so closing a Terminal or deleting its Session cannot create an orphan process.

Interrupted-Terminal recovery is supervised by one Runtime-wide four-spawn budget. Selecting a Session invalidates queued restore work from the previous selection, and the selected generation is revalidated after executable discovery immediately before PTY spawn. A visible interrupted Terminal retains the receiving Renderer grid before restore, starts its PTY and parsed screen at that grid when possible, and performs one ordered live-screen reattach after the record becomes `running`; this removes any remaining attach/spawn race without relying on a later ResizeObserver event. Startup Agent metadata probes are limited to the selected Session; another Session is probed when selected rather than during boot.

Exited Terminals retain their final output and reserve a compact recovery row beneath the xterm viewport, never over it. A zero exit without a signal is neutral; startup failures and signal or non-zero exits use a danger state. Surface actions, the command palette, and `Command+Shift+R` restart the same durable Terminal record, so recovery cannot create a duplicate tab or PTY identity. Restarting a bound Agent Terminal resumes its correlated provider session by default; only the separate `Start New Agent Session` action clears that binding and starts fresh, while Shell restarts always remain fresh.

## Files and editor

The editor remains intentionally narrow: open, edit, save, in-file search, and diff. Broader IDE
surfaces require a separate product decision rather than growing incidentally from file operations.

The Files inspector resolves a curated, deterministic subset of local LobeHub file icons by exact filename, well-known directory, test suffix, and extension before falling back to generic file and folder assets. Expanded directories use matching open variants. Vite emits only the explicitly imported SVG subset as separate assets, so icons remain offline-capable without embedding the full upstream catalog in the initial Renderer JavaScript bundle.

Agent identity is a Renderer-wide typed registry rather than a per-surface icon choice. Managed provider Terminal titles and icon accessible labels derive from the shared provider catalog; provider-specific assets stay in one exhaustive icon map, while Shell, reserved Grok/OpenCode, and unknown identities remain local fallbacks. Terminal tabs, Project Session rows, creation choices, Terminal Info cards, and Settings resolve the same identity. Brand SVGs are emitted as local build assets; monochrome icons inherit the active theme, and unsupported future adapters use a deliberate generic fallback. The Session hover/focus card is a Renderer-only projection of existing Project, Session, and primary-Terminal metadata; it never reads Terminal output, source contents, Agent transcripts, prompts, credentials, or settings. The Info inspector lists only Terminals owned by the selected Session, including their process state, PID when live, directory, and correlated Agent session ID; installed tools that were not started in that Session never appear there.

Every file request resolves its candidate path, obtains the authoritative root from the Session's Project, checks the candidate remains beneath that resolved Project root, rejects a replaced root symlink and descendant symlink escapes, and enforces text/size limits. Saves hold the validated inode open with `O_NOFOLLOW`, write and sync a same-directory temporary file, revalidate the target identity, then atomically rename the complete replacement over it and sync the directory; an interrupted save therefore leaves either the old full bytes or the new full bytes. Following VS Code's local disk-provider boundary, create, recursive copy, rename, and move use asynchronous Node filesystem APIs inside Runtime. Runtime coordinates document reads, saves, and mutations through one bounded path-aware scheduler: overlapping paths remain ordered, unrelated files continue during long operations, and recursive copies are serialized per Project. A document request that waits too long is canceled inside that scheduler before its filesystem operation starts; Main therefore leaves saves pending for Runtime's authoritative result instead of reporting a timeout while a write can still execute. Runtime revalidates source and target identities before mutation, rejects root changes, symlinks, hard-linked regular files, conflicts, and directories copied or moved into themselves, and reserves target paths so concurrent Caxri requests cannot select the same name. Recursive copies preflight a bounded manifest for entry count and aggregate bytes, then use abortable Node file-handle streams so the operation deadline covers active transfer. A failed copy preserves its partial target because Node cannot atomically bind pathname deletion to a validated inode; structured failure records report the safe aggregate counts, duration, and operation phase without risking deletion of a foreign replacement. Source entries, destination directories, and created parent directories are revalidated throughout the copy. Path-based rename performs a final conflict check and Caxri-local reservation; Node has no atomic no-replace directory rename API, so an external process can still win the final path race. Keeping these narrow VS Code-aligned pathname limitations is an explicit tradeoff of the Node-only implementation. Cut/copy state is Renderer-local metadata scoped to one Project, while Runtime reauthorizes the source and target on every paste; copy/duplicate and cut-paste choose a bounded collision-free suffix. The Renderer coalesces repeated long copy or move intents, exposes an accessible pending status, disables duplicate triggers until completion, and reports success or failure. Main reveals an item in Finder only after Runtime authorizes the current Project-local regular file or directory. `Open in Terminal` supplies an optional cwd to `terminal.create`; Runtime canonicalizes it, requires a directory beneath that Session's Project root, captures its inode, and revalidates that identity in `TerminalManager` immediately before each path-based node-pty spawn, including restart and restore. A final check-to-spawn race remains because node-pty accepts only a cwd pathname; this is the same explicit Node-only local-filesystem tradeoff, not a descriptor-backed sandbox boundary. For Trash, Main shows the native recovery warning, repeats Runtime inode and Project-root authorization after confirmation, and then calls Electron's path-based `shell.trashItem`; there is no permanent-delete fallback. Successful mutations invalidate affected file-tree queries for every Session sharing the Project. Successful renames and moves also remap normal editor tabs, independent dirty buffers, and in-flight reads or writes for the item and its descendants across those Sessions; successful Trash operations close affected tabs and discard pending document completion across the same scope. Directory identity is revalidated around enumeration so a path swap cannot disclose another directory, and entry metadata reads use a bounded worker pool. Directories are lazy-loaded. The `Cmd+P` path browser uses a separate bounded `files.browse` request to scan only its current Project-local directory; navigation cancels stale Session scans, active scans share a small Runtime-wide concurrency budget, and browsing never triggers a Project-wide traversal. File-tree visibility follows the global VS Code-style `files.exclude` glob object and never reads `.gitignore`; dependency and build directories remain visible by default. `@parcel/watcher` uses the native recursive macOS backend, independently ignores VCS internals and dependency/build caches, coalesces bursts, and watches the active root only. Polling is inactive while that backend is healthy; a bounded fallback starts only after native setup or delivery fails and polls the active root plus expanded directories that are not excluded by the watcher traversal policy. A normal watcher batch reloads only the directory that directly owns a changed path, while overflow reloads all visible directories and switching Session identity intentionally resets expanded absolute paths.

Create, rename, and move use a durable Runtime operation ID and journal under Electron user data. Each new record captures the originating Workbench Project before crossing an asynchronous boundary; legacy records without that field resolve to the owning Project because they predate alternate roots. A `pre_stage` record may time out or cancel before any file-system mutation; once the final path and source identity checks persist a `staged` record, the native mutation continues even if Main's ordinary request deadline expires. Source and parent identities are checked again after that durable write, and create records add the newly created inode before reporting completion. Final records remain queryable until the Renderer refreshes affected file trees and reconciles root-scoped dirty buffers. Before acknowledgement removes a completed rename or move, Runtime idempotently remaps the originating Project's SQLite editor snapshot for every participating Session, including snapshots that became inactive after a root switch. Runtime restart converts abandoned pre-stage records to canceled, reconciles a staged create only against its confirmed post-create inode, and reconciles staged rename or move only when the target still has the original source inode and the source path is absent; uncertain results preserve every path and force a file-tree refresh. Per-Session execution slots remain occupied until the underlying call settles even after cancellation or acknowledgement, while retained results and pre-stage time are separately bounded. Phase logs include the operation ID, kind, Session, phase, and duration, never file contents.

Project search is a Session-scoped Runtime read, never a Renderer-supplied root or command. Name and content scans use an independent bounded traversal policy for VCS metadata, dependencies, and build caches rather than `files.exclude`; they revalidate directory/root identity, reject symlinks, skip binary and oversized documents, and cap time, scanned files, matches, snippets, and total IPC payload. A newer search aborts the prior scan for that Session; the Renderer also keys results by the complete query so a stale response cannot replace a newer query. Content options cover case, whole word, regular expression, include, and exclude matching, while Monaco reveal intents remain keyed by the Session-specific model URI.

External disk changes always replace an open buffer, including a dirty buffer. This is a deliberate product choice for agent-driven workflows; the Renderer clears dirty state and shows a non-blocking notice rather than opening a conflict dialog. Editor buffers and Monaco model URIs are keyed by Session identity as well as path so Sessions sharing one root cannot reuse each other's dirty state. The Renderer document cache is the sole source of dirty truth because SQLite does not persist unsaved bodies: durable Session tabs are always clean, while a Runtime-only restart reconciles its clean snapshot with surviving Renderer documents before preview replacement or dirty indicators read it. A full Renderer/application restart has no recoverable dirty body and therefore resumes from clean disk state; legacy durable dirty flags are normalized on read. The Renderer reconciles a transient motion identity per Session so clean preview replacement and pinning preserve one visual tab instance, while actual add/close still enter or exit. Clean document contents share a 32 MiB Renderer cache budget across Sessions; dirty buffers are the only exception because reclaiming them would lose unsaved work, and they displace clean buffers first. Closed models do not retain Monaco view state. When a Session becomes active again, cached documents are compared with current disk version metadata; only actual disk changes replace its inactive dirty buffers.

Git file selections open read-only virtual editor tabs instead of embedding patch text in the Inspector. A single-file tab renders a Monaco side-by-side diff; a repository `Open Changes` tab renders its changed files as one scrollable multi-diff surface. Multi-diff rows load their bounded document and mount Monaco only near the viewport; a binary or transient per-file failure remains local to that row. The virtual tab key persists the opaque repository ID and repository-relative path so reload can reconstruct the diff without treating it as a writable filesystem document.

For a normal active file tab, Monaco publishes only cursor, selection length, and language identity to Renderer-local Status Bar state. Current-line blame is a bounded, Session-rooted Runtime Git request that selects the deepest approved repository containing the file and returns commit metadata only; diff tabs never masquerade as writable files or issue blame requests.

## Settings, keybindings, and themes

Global `settings.jsonc`, `keybindings.jsonc`, and theme files live in the application data directory. Writes sync a mode-`0600` temporary file before atomic replacement, and in-memory state changes only after replacement succeeds. The Runtime prefers Parcel Watcher hot reload and falls back to polling only these three files. Startup, hot reload, update parameters, get results, and change events share a 256 KiB UTF-8 source ceiling; disk reads stop at that boundary before parsing, and keybinding arrays are capped at 1,024 entries. Schema or size errors retain defaults or the prior valid state and report location without including source text in diagnostics. Missing provider-scoped Agent launch and disabled-by-default lifecycle-hook settings and the nullable Terminal default cwd are supplied in memory without rewriting an older settings file. Each Agent provider's lifecycle integration can be enabled independently; installation health is a separate typed read/event surface because a saved preference does not prove that a provider loaded or trusted its hook. Trusted Domains are a bounded Settings array of normalized HTTP(S) exact origins or explicit subdomain wildcard origins. Runtime owns their JSONC-preserving atomic persistence, while Main alone may append the canonical exact origin selected in a trust prompt; Renderer can manage the complete array only through the ordinary validated Settings update. Object-valued `files.exclude` merges user booleans over bounded defaults, so a default pattern can be disabled with `false` without re-declaring every other default.

The Settings dialog opens in full-width structured UI mode. Its in-app source mode lazily mounts Monaco against the same reducer drafts, and it must parse successfully before returning to structured UI or switching source tabs. Runtime and Renderer import the same browser-safe Settings/keybindings file schemas from `src/shared/config.ts` (bound constants live in `src/shared/config-contract.ts`), so defaults, bounds, and source-to-UI validation cannot drift. Hook installation health describes the last applied settings only: an edited toggle reports `Pending Apply`, and the provider section tells users that Agent Terminals opened before enablement need a restart. View switching is a two-segment UI/Source toggle; the former external `Open Config File` action was removed because macOS has no default `.jsonc` association and the in-app source editor owns config editing.

Themes normalize into one semantic token structure consumed by CSS variables, xterm, and Monaco. Dracula is vendored as the first-run default. Importers support Caxri JSON, one VS Code JSON theme, iTerm2 `.itermcolors` plist, and Warp YAML; unsupported tokens become warnings and missing non-terminal tokens inherit from the active theme.

An Editor save revalidates the opened replacement inode and its canonical Project containment
before writing document bytes; `O_NOFOLLOW` alone would not stop a swapped parent-directory
symlink. Failure cleanup likewise unlinks the temporary pathname only while it still resolves to
the exact inode Caxri created; an untrusted replacement is preserved rather than risking deletion
outside the Project. Node has no atomic inode-compare-and-replace or
directory-handle-relative write/unlink primitive, so an uncooperative external process can still
win the narrow temporary-path validation-to-write, cleanup-validation-to-unlink, or final target
revalidation-to-rename race. The rename replaces a late symlink itself rather than following it;
these narrow pathname races are the same explicit Node-only local filesystem tradeoff as create,
rename, move, Trash, and PTY cwd launch.

## Git and Agent adapters

Git operations run via `execFile('git', argv)` with fixed argv constructors and a filtered environment. The only repository mutation exposed to the Renderer is switching to an existing local branch: Runtime resolves the opaque approved repository ID, re-lists its bounded local refs, and invokes `git switch -- <branch>` only after an exact match. There is no arbitrary checkout, fetch, reset, discard, or command surface. One Runtime-wide semaphore admits at most eight Git subprocesses, metadata commands cap output at 4 MiB, and bounded file-diff commands retain the configured file-size cap. A shared Runtime resolver checks the GUI PATH, then reads only a bounded marker-prefixed PATH from the login shell; it caches validated absolute executables and revalidates stale entries. Agent adapters, Agent PTYs, version probes, and the fixed Project Status allowlist (`gh`, `vc`, `linear`) use this resolver and its filtered environment without inheriting the rest of the shell environment. Claude Code integration reads only compact live-session metadata: at most 512 candidates, eight reads at once, and no more than 128 KiB from any file. Codex integration locates state beneath the documented `CODEX_HOME`/`CODEX_SQLITE_HOME` roots and queries a capability-detected thread index read-only; neither adapter opens transcripts. Available title, session ID, activity, and usage metadata are correlated with the persisted cwd of the matching provider Terminal. A provider-owned Agent session ID may be claimed by only one Terminal; unbound probes exclude IDs already claimed by another Terminal and IDs discarded by a restart. Every new Session starts with the automatic sidebar title `Untitled`, while its first Terminal keeps the provider-specific `Shell`, `Claude Code`, or `Codex` title. The first Agent Terminal becomes the Session's primary Agent Terminal and exclusively owns later automatic sidebar-title promotion from useful metadata; later Agent Terminals retain independent metadata without replacing it. A manual title remains stable across Agent metadata refresh, restart, and primary-Terminal succession. Closing the primary promotes the next Agent Terminal. Missing or changed storage produces `unknown`; it never interrupts PTY input/output or resets a known Session title.

A Shell Terminal can become an Agent Terminal when its unpublished input line launches `claude` or `codex`, either directly or through a shell alias. Runtime keeps a simple-command candidate in memory for a bounded window and confirms aliases from the PTY's active foreground process group using a fixed, bounded `ps` query; compound commands and background processes are excluded. Once the provider executable is confirmed, Runtime promotes the durable Terminal atomically so its shared icon and title update even before the provider writes session metadata. A later same-Project, unclaimed metadata session created after command submission supplies the Agent session ID and generated title. Shell input and process-list output are never logged or persisted, and ordinary output alone does not infer Agent identity.

Each directly launched Agent PTY generation receives an independent, short-lived Agent Endpoint ref
and token after Runtime has resolved its Project, Session, Terminal, provider, and launch configuration.
The filtered PTY environment carries the credential only for that direct launch; Host never persists
the token or publishes it through events, diagnostics, snapshots, or command output. Provider launch
evidence classifies only the built-in executable with an empty argument list as `standard`, exact
documented bypass flags as `elevated`, and custom executables or arguments as `unknown`. Endpoint
selectors use the opaque ref; duplicate display names never redirect a mutation to a newer generation.

Peer messages are Host-owned, generation-scoped, bounded plain text. Their bodies exist only in the
live in-memory Inbox and never enter Runtime, SQLite, logs, diagnostics, the event journal, Terminal
snapshots, or PTY input. `auto` accepts only same-Project peers whose known permission classes match;
otherwise the receiver's `accept`, `hold`, or `refuse` policy decides. Waiting and held queues are
bounded independently, and expiration or either Endpoint generation ending destroys every undelivered
body. A pull stays reserved until the authenticated local socket flushes its response; disconnecting
before that boundary requeues the message at the FIFO front. The held-message list and event contain
only a bounded preview; Desktop fetches the selected full in-memory body on demand and cannot approve
until that fetch succeeds. Approval moves only one held message into the receiver Inbox. Peer text
carries `origin: peer` and can never grant a permission,
change settings, invoke a slash command, wake an Agent, or write a user prompt.

Agent dispatch/control and human Terminal steer are separate command domains rather than Peer Inbox
fallbacks. A default Agent Endpoint can read same-Project dispatch receipts, but `agent:control` is a
bounded generation grant that adds `agents.dispatch` and `agents.control` for that Project only.
Runtime persists a dispatch receipt before a fresh Terminal or resumed PTY can spawn, fences resume
to the Terminal's exact provider session binding, and reports lifecycle changes from process events
without reading output or silence. Host and Runtime both revalidate an exact Endpoint generation
before an interrupt or stop reaches the current Caxri-owned PTY. A client disconnect explicitly
cancels its dispatch long poll.

`terminal.send` requires a Desktop or human CLI owner with `terminals.steer`. Its text is bounded by
UTF-8 bytes, rejects C0/C1 controls except Tab, and adds Enter only through the explicit flag. It
shares the existing content-free PTY input metrics and logs only target, byte count, and Enter state;
it never claims peer origin. Explicit message `--wake` requires both dispatch and control authority,
resumes only a bounded tombstone for the exact stopped generation, confirms the replacement Endpoint,
then admits the message under the same request identity. See `docs/agent-command-authority.md`.

Each Endpoint also exposes one typed messaging capability (`deliveryMode`, `health`, stable `reason`,
`checkedAt`, and `nextAction`). The Runtime probes the configured executable and version behind a
bounded cache; disabling the integration or invalidating the probe revokes messaging without stopping
the PTY. Unknown future Provider majors fail closed. The verified stable matrix is Claude Code
2.1.80+ within major 2 and Codex 0.147.0+ within major 0, both using `pull` through the version-matched
Caxri CLI. Claude custom Channels preserve a non-user source, but remain a research preview that
requires `--dangerously-load-development-channels`; Caxri therefore does not enable that flag or
advertise stable push. A future allowlisted Channel adapter must omit the independent
`claude/channel/permission` capability and acknowledge only after its exact transport delivery.
See [Claude Code Channels](https://code.claude.com/docs/en/channels) and the
[Channels reference](https://code.claude.com/docs/en/channels-reference). Codex 0.147.0 exposes no
documented peer-origin push boundary, so Caxri never guesses app-server frames or Provider storage.
Pull `wait` and `check` consume only after the authenticated Host reply flushes; timeout, cancellation,
or disconnect requeues the same FIFO message. The controlled version matrix and operator behavior
are recorded in `docs/provider-messaging.md`.

Provider lifecycle hooks follow one generic Runtime contract: provider-local adapters define documented events, config targets, schema inspection, render, and removal, while `src/runtime/agents/hooks/` exclusively owns filesystem reads, a cross-process install lock, mode-`0600` atomic replacements, debounced provider-config watching with a slow polling fallback, bridge staging, the authenticated local socket, and health reporting. Adapters add four content-free phases (`turnStarted`, `shellToolFinished`, `attentionRequested`, `turnFinished`) and remove only handlers carrying Caxri's marker. `shellToolFinished` is bound only to Claude Code and Codex Bash completion and is a timing signal for a fresh structured Git topology read; the bridge extracts only the opaque provider session identifier from provider stdin; commands, arguments, prompts, output, and transcripts are discarded before the signal crosses the bridge. Foreign hooks and comments are preserved, malformed trees and policy-disabled configs fail closed, Codex inline-hook conflicts are reported instead of merged, and removal independently preserves every newer marked schema even when another conflict is present. Main supplies the fixed per-user bridge root; tests omit it by default, while focused Electron coverage may opt into an isolated user-data hook root with `CAXRI_E2E_AGENT_HOOKS=1` so it cannot mutate real CLI configuration.

Provider hook intent is profile-scoped while provider configuration is user-global. The shared hook root persists a versioned union of enabled providers and paths by Caxri profile, prunes entries whose real profile directory was explicitly removed, and installs the remaining union under the same cross-process lock; one profile can remove a provider only after no recorded profile still enables it. This prevents independently configured worktrees from uninstalling each other's hooks, continuously rewriting the global provider files, or leaving an unremovable intent after profile cleanup.

The staged hook command path and arguments stay stable across ordinary application upgrades so provider trust does not churn; bridge implementation upgrades happen behind that path. A hook process reads provider stdin only to extract the opaque session identifier (bounded, never content), emits no prompt or response content, and sends only provider, phase, schema, Terminal, PTY generation, token, and that optional session identifier (capped at 256 characters) over a mode-`0600` Unix socket. Runtime accepts a signal only when its random token, independently established provider binding, schema, Terminal, and current generation all match; inheriting a token cannot promote a Shell Terminal. Startup removes a bounded set of same-profile socket paths whose encoded Runtime PID no longer exists. A validated attention-bearing hook phase is authoritative for Session activity/unread state until the next `turnStarted`, which updates activity and restores metadata attention as a fallback if that turn's later hook is lost. Capability-detected metadata remains authoritative for title and usage; Agent session identity follows metadata until a validated signal names a different provider session (a manual in-terminal resume), which rebinds the Terminal — never to a session another Terminal of the same provider owns — invalidates in-flight probes, and schedules a fresh metadata read. While hook authority is established later probes cannot overwrite hook activity or clear the resume binding. Disabling a provider immediately rejects later signals in that profile; only the last disabling profile removes current/older Caxri entries globally. Existing PTYs that predate enabling may need a restart to inherit the bridge environment.

The Git inspector treats the active Workbench Root repository, linked worktrees, nested repositories, and initialized submodules as independent status scopes. Its Working Tree mode uses the current index and filesystem, while its lazy Pull Request mode asks `gh pr view` for the current branch's validated base/head object IDs and diffs that committed range without mixing in local working-tree changes. Repository discovery uses structured Git output, coalesces concurrent summaries, and passes an opaque repository ID back for diff requests. `git.diffDocument` returns bounded original and working-tree text for Monaco without exposing an arbitrary Git command or weakening repository containment. Nested roots inherit the containing Workbench Project grant. A linked worktree outside that root becomes eligible only after a native directory-picker grant authorizes its exact canonical path as a Project; Git discovery and Agent hook signals never expand durable path authority by themselves.

Each approved Git scope also exposes lazy, independently pageable commit history through its opaque repository ID. Runtime parses fixed NUL-delimited `git log` fields, caps page size and offset, and accepts only an existing, non-symlink path contained by that repository for optional subtree history. Selecting a commit issues a separate read-only metadata/file-list request; merge commits compare through their first-parent history, file results are bounded, and no history request exposes checkout, reset, fetch, or another mutation.

The Project Status inspector is lazy: opening its tab asks Runtime to combine the approved primary repository and initialized submodules with GitHub PR/check data, deliberate Linear references from the PR body, and Vercel deployments. The always-visible Status Bar uses a separate lightweight primary-repository overview: it reads Git changes plus the origin and current GitHub PR, never triggering Linear or Vercel, and file events refresh only `git.summary`. Its branch picker lazily lists the approved primary repository's local refs and uses the narrow switch operation above; its additions/deletions are the tracked working-tree diff against `HEAD`, while untracked files remain visible in Source Control without synthetic line counts. Runtime invokes `gh`, `linear`, and `vc` only through structured argv arrays, filtered environment inheritance, timeouts, and bounded output; Renderer receives validated read models and never CLI access. Missing tools, authentication, links, rate limits, and timeouts stay scoped to the relevant surface, while external HTTP(S) links still pass through Main's trusted-origin policy.

## Security

BrowserWindows use `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, a restrictive CSP, blocked navigation, and denied new windows. Renderer may request only an HTTP(S) external open; Main re-parses and canonicalizes the URL, rejects credentials and unsupported protocols, and owns every system-browser call. Loopback origins are trusted by default. A configured exact origin or explicit wildcard matches only the same scheme and port; malformed rules fail closed. Every other origin requires a native confirmation, and choosing trust persists its canonical exact origin before opening. Passive navigation and new-window attempts remain denied rather than acquiring trust authority. No telemetry or remote upload exists.

Directory-picker results create single-use Main-process grants. A grant is revoked when the Agent choice or Workbench authorization is canceled, expires after 60 seconds if unused, and is consumed before Project creation reaches the Runtime. An automatic worktree candidate carries only an opaque ID to the Renderer; Main claims its canonical Runtime path and accepts a user selection only when its independently canonicalized path is exactly equal. Once a Project exists, new Sessions reference its stable owning ID and cannot submit or broaden a root path. A Workbench selection may reference only an already authorized Project that current structured Git topology proves is a linked worktree of that owner. The Runtime persists the selected root's device and inode, revalidates identity and topology on access/focus/watch failure, and atomically falls back to the owning Project when the worktree disappears or is replaced.

## Performance and observability

Host, Main, and Runtime record boundary timings for app readiness, Host/Desktop attachment, first window visibility, Runtime boot, PTY spawn, file listing, Git commands, Agent probes, and watcher readiness. Concurrent identical file, Git, Agent, and Terminal-start requests share one in-flight operation so development StrictMode and repeated UI requests do not duplicate native work. Agent Terminal output schedules a trailing metadata refresh with at most one timer per Terminal, allowing a CLI-generated title to reach the sidebar without opening the Info inspector. One Agent coordinator owns that scheduling and reads Agent Terminal membership from the durable Terminal record instead of a cached set, so no lifecycle path can leave the two disagreeing. Ordinary Shell and dev-server output never enters this probe path; only a bounded simple-command candidate may request coalesced foreground-process confirmation, after which normal Agent metadata refreshes take over.

Terminal input, resize, and output are high-frequency paths. Successful input and resize requests do not write individual records, repeated ResizeObserver grid sizes do not cross IPC, and Runtime ignores a resize that matches the live PTY grid so a remounted view cannot generate a redundant SIGWINCH. PTY throughput is emitted as periodic aggregate input, output, and dropped-byte counters. The PTY data callback updates only the in-memory parsed screen and live delivery queue; normal lifecycle finalization crosses the parser barrier and writes one bounded screen BLOB instead of persisting raw output periodically. Bootstrap loads all Session state rows in one query. Terminal exit, restart/restore, and Agent metadata events refresh only their identified records through one coalesced small read; application attach, Runtime recovery, and structural mutations retain full bootstrap as the convergence path. Monaco stays out of the terminal-first Renderer bundle; after Runtime attachment, a single shared idle preload primes editor-core plus JavaScript, TypeScript/TSX, JSON, HTML, CSS, Markdown, and dotenv tokenization before the first real file selection. Language workers remain demand-loaded.

`benchmark:startup` exercises a representative large repository and requires Runtime, Terminal, Files, and Git to become usable within three seconds. It also validates timed log coverage, zero request/watcher failures, aggregated terminal metrics, and fewer than 256 Runtime file descriptors. `benchmark:editor` separately launches isolated cold and idle-preloaded renderers. The common-language idle preload must complete within three seconds; the first JavaScript or TypeScript document, editor mount, and visible syntax highlight must complete within 250 ms of selection in both paths, and a repeated open must visibly highlight within the same bound.

## Diagnostics and privacy

Structured logs carry timestamp, process, level, event, correlation ID, duration, and the build's application version and commit when known. Diagnostics contain application/runtime versions, redacted metadata/state, counts, and timing summaries. Home paths normalize to `$HOME`; secret-like keys, bearer/API tokens, GitHub tokens, and Slack tokens are redacted. Bundles never include file contents, terminal output/snapshots, environment values, prompts/responses, or agent transcripts.

The application version and short commit hash are injected at build time and read once by Main, which stamps its own logs and forwards them to the Runtime's environment so both processes' logs and the diagnostics export can be correlated to the exact build.

Development launches write Host, Main, and Runtime JSONL files to the repository `logs/` directory for direct inspection. Packaged and test launches keep logs beneath the active Electron user-data directory so application data remains self-contained.

CLI `logs follow` resets to a 250 ms poll after output and exponentially backs off idle polling to a
two-second ceiling, avoiding repeated suffix reads and parsing when no new records exist.

## Recovery limits

Renderer or Desktop restart recovers Host-owned state and attaches to live PTYs. Runtime restart recovers database metadata and snapshots only; operating-system PTYs owned by the dead Runtime are not recoverable. Restart attempts are capped and use exponential backoff; a request that arrives while a crash-triggered restart is waiting out its backoff delay is queued to await that same restart rather than forking early. Startup fails visibly instead of hanging if no Runtime becomes ready within 15 seconds. Only explicit `host stop` is a durable process shutdown boundary.

A Renderer process crash (`render-process-gone`) reloads the window automatically with backoff (250ms, then 1s, then 4s). After three crashes within a 60-second window, automatic reload stops; Main logs the crash loop and shows a native dialog offering Relaunch or Quit instead of reloading indefinitely.

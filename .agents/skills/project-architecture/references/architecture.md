# Caxri architecture

## Product model

A `Project` is a user-authorized folder and the durable owner of its `rootPath`, explicit Sidebar order, and path-security grant. A `Session` belongs permanently to one owning Project and owns permanent Terminal records, root-scoped Workbench state, layout, and optional Agent metadata. Its independently persisted `Workbench Root` selects the authorized Project used by Files, Editor, Search, and Git; it defaults and falls back to the owning Project, while Terminal cwd, Agent launches, Agent Endpoint ownership, Sidebar grouping, and Session identity never move. Workbench navigation and dirty document identity use the tuple `(sessionId, workbenchProjectId, path)`, so switching roots restores independent tabs, selection, Git mode, and dirty buffers without merging same-named paths. See [ADR 0001](../../../../docs/adr/0001-separate-session-owner-and-workbench-root.md).

Session identity isolates Renderer editor, layout, SecondarySidebar, and navigation state. Every new
Session-scoped state surface must key or reset that state when the selected Session changes.
An external file opened through the explicit-path Desktop browser is not a Project resource: it is a
read-only virtual Editor document scoped to the current Session and Renderer lifetime. Its display path
and content remain in Renderer memory, and its virtual tab is stripped from every Session persistence
write, so no external path or content enters SQLite and no Project or Session is created for it.

Archiving a Session hides it from active navigation without stopping or deleting its Terminals, and restore only clears that metadata. The Sidebar keeps one global Archived Sessions entry even when its count is zero; a Renderer-only management dialog derives search, Project/Agent filters, Project grouping, and newest-first order from the existing bootstrap snapshot, then delegates restore and delete to the unchanged structured Session methods. Every new Session starts with the automatic title `Untitled`, while its initial Terminal keeps the provider-specific title. The first Agent Terminal becomes the source of later automatic title promotion from useful metadata. A user rename with a bound primary Agent first updates the provider-owned conversation through its public CLI boundary, then stores the provider-authoritative title under manual ownership; a provider failure leaves the Caxri title unchanged. A Session without a primary Agent has no external identity, so its rename remains local. Multiple Sessions can share one Project without duplicating its folder identity.

Project and Session deletion removes Caxri metadata only. It never removes the authorized Project
folder or user files.

## Process model

```text
Desktop Main
  -> secure BrowserWindow + native dialogs
  -> dedicated Process Explorer window + fixed process sampler
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
recovery. Desktop Main is otherwise replaceable: closing a window or quitting Desktop revokes its lease
and detaches views without stopping Server Core, Terminal Host, or PTYs. A Renderer reload attaches to
the same Server state and bounded Terminal snapshots. A Server Core crash causes its coupled Terminal
Host and live PTYs to be retired; supervision restarts Server Core with capped exponential backoff and
persisted Terminals become `dead`, never silently restored processes. Server Core must remain ready for
30 seconds before its restart budget resets, so ready/crash flapping fails closed after three restarts.

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

## IPC contract

`packages/protocol` is the browser-safe, transport-neutral source of truth for command and event
contracts. A command request uses `{ protocolVersion, id, method, params }`; every method declares
one owner (`server` or `desktop`), effect (`read`, `write`, or `control`), required capabilities,
idempotency policy, Zod parameter/result schemas, and an optional principal projection. The
negotiation welcome identifies the authenticated principal and enumerates granted capabilities and
supported commands, so callers can query support without inferring it from errors. Desktop bridge
imports consume the owning `packages/protocol` public export; no other tree may define a second method
or schema table. Protocol source is grouped behind six domain barrels:
`agent`, `configuration`, `desktop`, `domain`, `registry`, and `transport`; the package root is the
only public package entrypoint. Do not add or remove one of those domains without updating this
reference and `scripts/__tests__/workspace-contract.test.ts`.

`packages/system` stays free of product domain state and native Desktop dependencies. It owns
reusable process, filesystem, observability, build, and test-harness primitives for non-browser
consumers.

`packages/utils` is browser-safe and free of runtime dependencies. It holds pure functions only.
Domain types, protocol schemas, and React code never move there.

The shared dispatcher validates protocol version, command, parameters, principal, capabilities,
owner availability, and results before it returns `{ protocolVersion, ok, result | error }`. Read
commands may execute again; write and control commands coalesce the same principal/request ID and
reject an ID reused with different command content. The Electron adapter additionally validates the
requesting WebContents before invoking that dispatcher. Internal Server methods remain outside the
public command registry.

`apps/cli` is the command-line adapter for the same registry and authenticated Server transport.
Source keeps `commands` as its only domain barrel; the package root remains the composition root
(`application`, `environment`, `output`, `selectors`) and the only public package entrypoint. The
command barrel stays thin, and tests live in the nearest `__tests__/` directory. Do not add or
remove that domain without updating this reference and
`scripts/__tests__/workspace-contract.test.ts`. Keep Electron, SQLite, PTY, watcher, and other
Desktop native dependencies out of its production dependency graph.
The offline `capabilities` response serializes the
registry's Zod parameter and result schemas together with owner, effect, capability, and
idempotency metadata. Human TTY, JSON, and ID-only output modes share closed error codes;
Agent and CI contexts default to JSON and never prompt. A mutation requires
an explicit profile plus any command-specific Project, Session, or Terminal selector and cannot
infer a target from uniqueness. The CLI may discover the private Server manifest and connect through
its authenticated loopback WebSocket, but it cannot read persistence, logs, configuration files, or
Desktop IPC. The CLI derives the Server artifact only when the current process, resources directory,
and script path match the immutable packaged application layout; no environment variable can nominate
a process to spawn. Human commands may adopt or start one detached Server, while Agent and CI commands
only connect to an already-running Server and Agent Endpoint credentials remain bound to
their generation. The shared WebSocket control decoder bounds every JSON message before schema
validation. Authenticated Desktop lease renewals bypass the ordered business-command queue so a bounded
long-running file operation cannot expire the active Desktop generation.
Top-level `open|reveal` submit only one bounded path and optional Session ID to Server Core. Server Core
revalidates Project containment and replaces that path with a one-use, generation-bound opaque
target before Desktop Main can open or reveal it. CLI retries use the shared request-ID idempotency
contract and never call Electron, Finder, or a shell directly.
For a directly managed Agent PTY, Server Core creates a separate Endpoint credential immediately before
the Terminal Host spawn request. Server Core stores only its digest and fences every command by Server,
Endpoint, generation, and launch identity; restart, exit, close, deletion, Server Core crash, and
expiry revoke it. The inherited Agent credential supplies same-Project read capabilities by default,
while bounded generation grants add debug, business-write, or Agent-control capabilities. A Shell
promotion never receives an Endpoint. These bearer capabilities are a product authorization boundary,
not a sandbox from same-user code that can independently read the private owner manifest.

The canonical provider-neutral Agent guide lives at `skills/caxri-cli/SKILL.md`. The CLI build
validates its executable examples and capability marker against the same command registry, then
embeds the exact skill files in the standalone artifact with CLI/protocol compatibility metadata and
a content hash. Offline `skills list|get|status` never opens the Server transport or emits local paths.
Explicit install/update operations target only the documented Project-local or user-global skill
directory for the selected Codex or Claude provider. A complete immutable release is written beside
the Provider-visible entry before one relative directory symlink publishes it; update atomically
switches that symlink, so a loader sees either complete version. Mutations anchor themselves to the
verified parent inode, mark and bound the managed release tree, preserve sibling and unmarked
entries, and fail closed for modified, unknown-schema, or newer installations; removal applies only
to intact current or older marked entries. Neither provider exposes a stable, documented per-Session
skill injection boundary in the controlled version matrix, so Caxri reports local installation
instead of altering Provider launch flags or private state.

Server Core owns durable structural events in a monotonic, bounded cursor journal: a reconnect receives
an intact suffix or
a bounded ID/revision snapshot when its cursor has fallen behind. Terminal output never enters that
journal; one-shot Desktop commands are transient too. Main keeps a second local journal only for
Renderer reloads. Terminal output retains its specialized attachment, snapshot, and backpressure path. Structural state
changes request the full bootstrap convergence snapshot; steady-state Terminal and Agent metadata
events carry typed Session/Terminal identities and use the bounded `app.records` read so they never
resend the whole application graph. An unrecognized state-change scope normalizes to the full
convergence path.

Server Core resolves that table through one composition root. `createServerDomainService(deps)`
constructs and wires every domain service from injected dependencies (data directory, logger, event
sink, and Terminal/Agent seams) and returns an exhaustive handler table plus one disposal path. The
Server Core entrypoint therefore owns composition and transport only, while the request surface remains
exercisable in-process without Electron. One dispatcher validates each request, invokes its handler,
records the request boundary, and classifies failures.

Server domain placement follows one scale rule: a domain may remain flat while it has at most two
production modules; at three or more cohesive modules it owns `apps/server/src/domains/<domain>/`,
exposes its boundary through `index.ts`, and keeps tests in that directory's `__tests__/`. Git,
Terminal, Agents, Files, and DB use this nested shape. Production cross-domain imports stay relative
and target only the domain root; a focused structure test rejects a missing barrel or deep cross-domain
import.

Failures carry a closed error code (`VALIDATION`, `FORBIDDEN`, `NOT_FOUND`, `PATH_DENIED`,
`CAPACITY`, `UNAVAILABLE`, `TIMEOUT`, `CONFLICT`, `IO`, `GIT`, `INTERNAL`). Server Core and Desktop
Main encode a `CaxriError` into protocol replies, and Client or Preload boundaries rebuild it on the
other side, so a code survives every process hop instead of degrading into an opaque message.
Unrecognized codes decay to `INTERNAL`, and only `INTERNAL` failures log a stack.

The workbench preload exposes one `request` method backed by a fixed method union plus `onEvent` and
a content-free `reportError` classifier. The Process Explorer preload has the same error classifier
beside its read-only snapshot/theme methods. Renderer entries report only `page-exception` or
`unhandled-rejection`; exception values never cross the bridge. Main validates both the sender and
kind, then writes stable structured events. The preload does not expose `ipcRenderer`, Electron
objects, environment data, or generic filesystem/process access. Server Core, Desktop Main, Terminal
Host, and Extension Host observe fatal runtime errors through `uncaughtExceptionMonitor`, which
preserves their crash/exit behavior, and use a bounded early-startup buffer plus a synchronous bootstrap
logger. Server Core starts both private children with allowlisted environments containing only their
process-launch context and Caxri-owned paths; ambient credential variables are not copied.

Every Electron Playwright spec uses `e2e/support/fixtures.ts`. `launchCaxriApp` registers each application
with that automatic fixture, which observes all Renderer pages, captures Desktop Main, Server Core,
Terminal Host, and Extension Host logs before profile cleanup, stops the isolated Server on the final
launch, and fails on any
undeclared error/fatal event. Intentional faults use exact
source/event/code/count allowances; unconsumed allowances fail so repaired faults cannot leave stale
suppression behind.

## Persistence

SQLite runs only in the Server Core and uses WAL, foreign keys, transactions, and busy timeout. Table definitions live declaratively in `apps/server/src/domains/db/schema.ts` (Drizzle ORM); `bunx --bun drizzle-kit generate` emits the checked-in SQL under `apps/server/src/domains/db/migrations/`, which the Server Core bundles via the validated `migrations/manifest.ts` `?raw` imports so packaged builds never read migration files from disk. After any schema change, regenerate with drizzle-kit, then add the generated migration to that manifest — never hand-edit the migrations directory. The manifest must match the Drizzle journal exactly and derives `user_version` from the schema 7 preservation floor plus every later migration. Older experimental databases may still be rebuilt, but schema 7 and every later version advance transactionally without deleting Projects, Sessions, Terminals, snapshots, selection, or layout state. Database composition writes the same derived version to `app_state.schemaVersion`. Caxri's public data-compatibility commitment begins with v1.0.0, backed by that preserved chain; adding a schema version requires both generated SQL and an N-1 upgrade test. Query modules use the Drizzle query builder while the raw better-sqlite3 handle remains for pragmas and transactions. The schema contains:

- `projects`: identity, unique root, display title, explicit Primary Sidebar order, and timestamps
- `sessions`: Project ownership, identity, creation/visit timestamps, the allowlisted Session Activity clock and reason, reversible archive time, primary Agent Terminal and Agent Activity state, attention generations, layout version, and automatic/manual title ownership
- `terminals`: durable identity/position/cwd/title/icon/provider and last process state
- `terminal_snapshots`: versioned bounded VT/text payload with source grid, line, and byte counts
- `session_state`: versioned open editor tabs, active tab, desired Secondary Sidebar ViewContainer ID, recursive Terminal split layout, and the last durable file-mutation editor-remap operation ID so at-least-once recovery stays idempotent across Renderer reloads; invalid JSON, invalid shapes, or unsupported versions repair to a default layout and emit a content-free warning instead of failing bootstrap
- `app_state`: last selected Project and Session, window state, active theme, and schema version

A successfully parsed Workbench Root snapshot is also checked against the Session's current durable
Terminal ownership. Historical tabs for deleted Terminals are pruned on first read and that Root is
rewritten immediately, while sibling Root snapshots, extension Tree View state, and editor-remap
identity remain intact.

Snapshots retain at most 2,000 lines and 2 MiB per Terminal. Each live PTY owns a Terminal Host-side
headless xterm screen whose ordered write and resize queue preserves cursor-addressed state. A live
attach first moves that screen and PTY to the receiving Renderer grid, then crosses an exact queue
barrier and replays a bounded serialized screen before later output. A Renderer subscribes before
attaching, then replays that bounded snapshot ahead of output received during attachment. Bytes already
represented by that snapshot are removed from the live-output queue before replay to prevent
duplication. Detached Terminals retain the parsed screen in memory without broadcasting output to an
invisible view. Exit, restart, and orderly or terminate shutdown persist that same parsed screen plus
its exact source grid as encoding 3 after excluding interaction modes; raw PTY bytes are never durable
recovery data. Renderer recovery disconnects normal resize observation, restores the serialized
framebuffer at that source grid, waits for xterm parsing and buffered output to finish, then fits once
to the current pane and resumes observation. Older, malformed, or unknown encodings fail closed and
restore an empty screen. An unclean Server or Terminal Host loss can therefore lose the current
generation's latest visual history instead of replaying unsafe raw input. Snapshots are UI restoration
data, not proof that a process survived.

## PTY lifecycle and backpressure

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

When at least one provider lifecycle integration is enabled, the launch plan adds only an opaque PTY
generation, local hook-signal path, and random authentication token immediately before spawn; that
generation is revoked before restart, exit, or close. A new Terminal resolves the global default cwd
(`~` supported) or falls back to its Project root before its durable record is inserted; restarts always
reuse that record, and Files/Git authorization remains anchored to the Project root. Switching Sessions
detaches views but does not stop PTYs. Renderer output delivery is coalesced; per-Terminal queues have a
byte ceiling and report a discontinuity when the Renderer cannot keep up. The Renderer discards that
incomplete batch and requests a fresh authoritative screen attachment, coalescing further gaps during
recovery into one follow-up attachment. Durable Terminal creation is capped at 16 per Session and 32
globally. The Renderer bundles JetBrains Mono's four terminal faces plus Symbols Nerd Font Mono as a
fallback and loads them before xterm measures its cells, so packaged builds do not depend on
system-installed terminal fonts.

Terminal file-link detection accepts only the current-user Home shorthand `~/...`; Renderer forwards
that raw text, the owning Terminal ID, and an optional editor location without learning or expanding
Home. Server Core expands Home, rejects escape and non-regular targets, and reuses a canonical Project
that already contains the file. A target outside all Projects remains unread until Main obtains a
native folder selection, Server Core proves that exact root contains the canonical target, and Main
consumes the existing single-use grant to create or reuse the Project. Main then selects the unique
target Session, creates a no-Terminal Session when none exists, or requires a native choice when the
target Project has multiple reasonable Sessions. The final open still uses Server Core's one-use Desktop
target: Server Core's approved root/file identity becomes an expected identity that Server Core compares with
its first `files.authorizeOpen` result, then Server Core revalidates that captured result again when Main
redeems the target. Home expansion never creates a permanent single-file exception or a Renderer
filesystem capability.

Provider output recovery is an explicit, disabled-by-default Terminal steering policy for unstable Agent
connections. Terminal Host matches bounded, case-insensitive literal suffixes only after the latest PTY
output has settled in the parsed headless-xterm screen; ANSI bytes and arbitrary raw chunks are never
match inputs. A match is fenced to the exact live PTY generation, sends fixed Escape and `continue`
bytes with separately bounded delays, yields immediately to real user input, and is canceled by settings
or lifecycle changes. The same suffix cannot fire again until parsed output stops matching it, and a
rolling three-attempt limit prevents unattended loops. Logs and transient feedback carry only
Terminal/provider/status metadata; user-authored patterns and Terminal content never enter events,
logs, or diagnostics exports.

Terminal groups form a persisted binary split tree with horizontal or vertical direction and a bounded
ratio. Dragging a tab moves its durable Terminal ID between groups or creates a new split; shared
reducers collapse empty groups and validate that one Terminal cannot appear twice. Moving a view may
detach and reattach xterm, but the Terminal Host-owned PTY is neither restarted nor duplicated.
Keyboard-adjustable separators and group labels preserve accessible focus semantics.

The active Terminal's Status Bar metrics are sampled by Terminal Host. A fixed `ps` argv reads only PID,
PPID, and RSS for the live PTY process tree every two seconds while that Terminal is visible; Renderer
receives aggregate memory and descendant count, never commands or environment data. Sampling stops when
a file tab is active and an exited PTY returns no usage.

Default `Command+K`, `Command+T`, and `Command+W` bindings clear the active xterm view, create a Terminal in the active group, and close the active Terminal through its normal lifecycle. `Command+Shift+Enter` configures Tab followed by LF when a Terminal owns focus; the VS Code-compatible `sendSequence` command normalizes that LF to Return before accepting the active completion and submitting it. Clear is Renderer-local and never sends input or a signal to the PTY. All bindings remain configurable, and app-wide commands are ignored while a modal dialog is open. Command-backed native menu items derive placement, ordering, labels, and accelerators from the shared command catalog and live keybindings; only standard Electron role items stay explicit in Main. The Server Core owns the unified ViewContainer/View/Command descriptor catalog. Builtin React surfaces and extension Tree Views use the same selection, command, and persistence path; Renderer only dispatches the descriptor's `viewKind`.

`workbench.action.terminal.sendSequence` is an argument-required keybinding command: `args.text` is decoded by JSONC, normalizes CRLF and LF to Return like VS Code's `sendText`, and sends every other byte unchanged through the existing typed `terminal.input` path to the active PTY, with the same 65,536-character bound as direct xterm input. The lower-level `terminal.input` contract remains byte-preserving so direct xterm input, Ctrl+J, and multiline paste keep their original meaning. Keybindings may use the `terminalFocus` context so the chord falls through outside xterm. Contextual bindings are dispatched in the Renderer and do not become Electron native-menu accelerators because Main cannot evaluate DOM focus; source order remains authoritative, and the first binding whose context matches wins. Argument-required commands stay out of the Command Palette and cannot be added as an incomplete binding by the structured shortcut editor, but a complete source-authored binding remains visible and its chord remains editable there.

The Agent Actions picker targets one captured, running Agent Terminal. A typed `agentActions.list` read asks Server Core to derive provider-owned discovery roots from the Terminal's durable provider, cwd, and authorized Project; Renderer cannot submit a filesystem root. Server Core traverses only bounded canonical roots, rejects symlink escape, reads bounded scalar frontmatter metadata without returning source bodies or paths, then applies provider defaults, discovered items, and explicit user overrides in that order. The resulting list is capped at 256. Insert and run both reuse the existing structured `terminal.input` method as append-only PTY writes. An exhaustive provider-and-action-kind plan sends inserts, commands, and Claude Code skills in one write; Codex skills use one invocation write, a 150ms paste-burst settle window, then a Tab-plus-Return write to accept the completion and submit the composer. No method reads, clears, or replaces the current draft. See [Agent Actions](../../../../docs/agent-actions.md).

Closing the last macOS window with live PTYs asks whether to keep running, terminate and close, or
cancel. `Keep Running` detaches every Renderer view and closes the window while Server Core, Terminal
Host, and PTYs remain alive; reopening creates a new window and attaches it to the live Server. `Quit
Caxri Desktop` persists window state, detaches views, and disconnects Main, but only the frozen public
`host stop` control terminates PTYs and shuts down Server. Dead Terminals remain visible and can be
restarted. In-flight Agent CLI discovery is revalidated against durable metadata before a PTY is
registered, so closing a Terminal or deleting its Session cannot create an orphan process.

Interrupted-Terminal recovery is supervised by one Server Core-wide four-spawn budget. Selecting a Session invalidates queued restore work from the previous selection, and the selected generation is revalidated after executable discovery immediately before PTY spawn. A visible interrupted Terminal retains the receiving Renderer grid before restore, starts its PTY and parsed screen at that grid when possible, and performs one ordered live-screen reattach after the record becomes `running`; this removes any remaining attach/spawn race without relying on a later ResizeObserver event. Startup Agent metadata probes are limited to the selected Session; another Session is probed when selected rather than during boot.

Exited Terminals retain their final output and reserve a compact recovery row beneath the xterm viewport, never over it. A zero exit without a signal is neutral; startup failures and signal or non-zero exits use a danger state. Surface actions, the command palette, and `Command+Shift+R` restart the same durable Terminal record, so recovery cannot create a duplicate tab or PTY identity. Restarting a bound Agent Terminal resumes its correlated provider session by default; only the separate `Start New Agent Session` action clears that binding and starts fresh, while Shell restarts always remain fresh.

## Files and editor

The editor remains intentionally narrow: open, edit, save, in-file search, and diff. Broader IDE
surfaces require a separate product decision rather than growing incidentally from file operations.

The Files view resolves a curated, deterministic subset of local LobeHub file icons by exact filename, well-known directory, test suffix, and extension before falling back to generic file and folder assets. Expanded directories use matching open variants. Vite emits only the explicitly imported SVG subset as separate assets, so icons remain offline-capable without embedding the full upstream catalog in the initial Renderer JavaScript bundle.

Agent identity is a Renderer-wide typed registry rather than a per-surface icon choice. Managed provider Terminal titles and icon accessible labels derive from the shared provider catalog; provider-specific assets stay in one exhaustive icon map, while Shell, reserved Grok/OpenCode, and unknown identities remain local fallbacks. Terminal tabs, Project Session rows, creation choices, Terminal Info cards, and Settings resolve the same identity. Brand SVGs are emitted as local build assets; monochrome icons inherit the active theme, and unsupported future adapters use a deliberate generic fallback. The Session hover/focus card is a Renderer-only projection of existing Project, Session, and primary-Terminal metadata; it never reads Terminal output, source contents, Agent transcripts, prompts, credentials, or settings. The Info view lists only Terminals owned by the selected Session, including their process state, PID when live, directory, and correlated Agent session ID; installed tools that were not started in that Session never appear there.

The browser-safe Agent provider catalog owns provider identity, display metadata, executable names, and declared UI
capabilities. Generic schemas, Settings options, Renderer filters, invalidation, test isolation, and other provider-wide
consumers iterate that catalog. Server Core provider descriptors own launch behavior such as resume argv and local-state
adapters. Safety arguments, verified versions, messaging, lifecycle syntax, CLI skill installation, assets, and every
other provider-specific decision remain exhaustive `AgentProvider` policies so a catalog extension fails closed until
each owning layer records an explicit decision.

Every file request resolves its candidate path, obtains the authoritative root from the Session's Project, checks the candidate remains beneath that resolved Project root, rejects a replaced root symlink and descendant symlink escapes, and enforces text/size limits. Saves hold the validated inode open with `O_NOFOLLOW`, write and sync a same-directory temporary file, revalidate the target identity, then atomically rename the complete replacement over it and sync the directory; an interrupted save therefore leaves either the old full bytes or the new full bytes. Following VS Code's local disk-provider boundary, create, recursive copy, rename, and move use asynchronous Node filesystem APIs inside Server Core. Server Core coordinates document reads, saves, and mutations through one bounded path-aware scheduler: overlapping paths remain ordered, unrelated files continue during long operations, and recursive copies are serialized per Project. A document request that waits too long is canceled inside that scheduler before its filesystem operation starts; Main therefore leaves saves pending for Server Core's authoritative result instead of reporting a timeout while a write can still execute. Server Core revalidates source and target identities before mutation, rejects root changes, symlinks, hard-linked regular files, conflicts, and directories copied or moved into themselves, and reserves target paths so concurrent Caxri requests cannot select the same name. Recursive copies preflight a bounded manifest for entry count and aggregate bytes, then use abortable Node file-handle streams so the operation deadline covers active transfer. A failed copy preserves its partial target because Node cannot atomically bind pathname deletion to a validated inode; structured failure records report the safe aggregate counts, duration, and operation phase without risking deletion of a foreign replacement. Source entries, destination directories, and created parent directories are revalidated throughout the copy. Path-based rename performs a final conflict check and Caxri-local reservation; Node has no atomic no-replace directory rename API, so an external process can still win the final path race. Keeping these narrow VS Code-aligned pathname limitations is an explicit tradeoff of the Node-only implementation. Cut/copy state is Renderer-local metadata scoped to one Project, while Server Core reauthorizes the source and target on every paste; copy/duplicate and cut-paste choose a bounded collision-free suffix. The Renderer coalesces repeated long copy or move intents, exposes an accessible pending status, disables duplicate triggers until completion, and reports success or failure. Main reveals an item in Finder only after Server Core authorizes the current Project-local regular file or directory. `Open in Terminal` supplies an optional cwd to `terminal.create`; Server Core canonicalizes it, requires a directory beneath that Session's Project root, captures its inode, and revalidates that identity in `TerminalManager` immediately before each path-based node-pty spawn, including restart and restore. A final check-to-spawn race remains because node-pty accepts only a cwd pathname; this is the same explicit Node-only local-filesystem tradeoff, not a descriptor-backed sandbox boundary. For Trash, Main shows the native recovery warning, repeats Server Core inode and Project-root authorization after confirmation, and then calls Electron's path-based `shell.trashItem`; there is no permanent-delete fallback. Successful mutations invalidate affected file-tree queries for every Session sharing the Project. Successful renames and moves also remap normal editor tabs, independent dirty buffers, and in-flight reads or writes for the item and its descendants across those Sessions; successful Trash operations close affected tabs and discard pending document completion across the same scope. Directory identity is revalidated around enumeration so a path swap cannot disclose another directory, and entry metadata reads use a bounded worker pool. Directories are lazy-loaded. Identical concurrent directory reads share one bounded Server Core producer; cancellation stops only that caller's wait and never aborts another caller that joined the same read. The `Cmd+P` path browser uses a separate bounded `files.browse` request to scan only its current Project-local directory; navigation cancels stale Session scans, active scans share a small Server Core-wide concurrency budget, and browsing never triggers a Project-wide traversal. File-tree visibility follows the global VS Code-style `files.exclude` glob object and never reads `.gitignore`; dependency and build directories remain visible by default. `@parcel/watcher` uses the native recursive macOS backend, independently ignores VCS internals and dependency/build caches, coalesces bursts, and watches the active root only. Polling is inactive while that backend is healthy; a bounded fallback starts only after native setup or delivery fails and polls the active root plus expanded directories that are not excluded by the watcher traversal policy. A normal watcher batch reloads only the directory that directly owns a changed path, while overflow reloads all visible directories and switching Session identity intentionally resets expanded absolute paths.

The Project-local description above is the anchored `Cmd+P` mode. Backspace or Delete at the start of
its empty input removes the Project anchor and enables the local Desktop's explicit-path mode. That mode
accepts current-user `~`, parent and relative paths, and `/`-rooted absolute paths, then lists matching
folders and files without a native picker. Main resolves the user-entered path, bounds concurrent
enumeration and entry count, keeps canonical locations and candidates behind opaque browser and entry
IDs, revalidates directory and file identity, rejects symbolic-link traversal, and reads only bounded
regular text files through a no-follow descriptor. Free-path browsing has no create authority. A result
inside the current Project returns through the existing authorized editable Editor path, and entering one
of its directories restores the Project anchor. An external result returns one read-only snapshot to a
virtual Editor tab in the current Session; its real path and content are never durable, and Session
persistence strips the tab itself. It never creates or reuses a Project or creates another Session.

Create, rename, and move use a durable Server Core operation ID and journal under Electron user data. Each new record captures the originating Workbench Project before crossing an asynchronous boundary; legacy records without that field resolve to the owning Project because they predate alternate roots. A `pre_stage` record may time out or cancel before any file-system mutation; once the final path and source identity checks persist a `staged` record, the native mutation continues even if Main's ordinary request deadline expires. Source and parent identities are checked again after that durable write, and create records add the newly created inode before reporting completion. Final records remain queryable until the Renderer refreshes affected file trees and reconciles root-scoped dirty buffers. Before acknowledgement removes a completed rename or move, Server Core idempotently remaps the originating Project's SQLite editor snapshot for every participating Session, including snapshots that became inactive after a root switch. Server Core restart converts abandoned pre-stage records to canceled, reconciles a staged create only against its confirmed post-create inode, and reconciles staged rename or move only when the target still has the original source inode and the source path is absent; uncertain results preserve every path and force a file-tree refresh. Per-Session execution slots remain occupied until the underlying call settles even after cancellation or acknowledgement, while retained results and pre-stage time are separately bounded. Phase logs include the operation ID, kind, Session, phase, and duration, never file contents.

Project search is a Session-scoped Server Core read, never a Renderer-supplied root or command. Name and content scans use an independent bounded traversal policy for VCS metadata, dependencies, and build caches rather than `files.exclude`; they revalidate directory/root identity, reject symlinks, skip binary and oversized documents, and cap time, scanned files, matches, snippets, and total IPC payload. A newer search aborts the prior scan for that Session; the Renderer also keys results by the complete query so a stale response cannot replace a newer query. Content options cover case, whole word, regular expression, include, and exclude matching, while Monaco reveal intents remain keyed by the Session-specific model URI.

External disk changes always replace an open buffer, including a dirty buffer. This is a deliberate product choice for agent-driven workflows; the Renderer clears dirty state and shows a non-blocking notice rather than opening a conflict dialog. Editor buffers and Monaco model URIs are keyed by Session identity as well as path so Sessions sharing one root cannot reuse each other's dirty state. The Renderer document cache is the sole source of dirty truth because SQLite does not persist unsaved bodies: durable Session tabs are always clean, while a Server Core-only restart reconciles its clean snapshot with surviving Renderer documents before preview replacement or dirty indicators read it. A full Renderer/application restart has no recoverable dirty body and therefore resumes from clean disk state; legacy durable dirty flags are normalized on read. The Renderer reconciles a transient motion identity per Session so clean preview replacement and pinning preserve one visual tab instance, while actual add/close still enter or exit. Clean document contents share a 32 MiB Renderer cache budget across Sessions; dirty buffers are the only exception because reclaiming them would lose unsaved work, and they displace clean buffers first. Closed models do not retain Monaco view state. When a Session becomes active again, cached documents are compared with current disk version metadata; only actual disk changes replace its inactive dirty buffers.

Git file selections open read-only virtual editor tabs instead of embedding patch text in the Inspector. A single-file tab renders a Monaco side-by-side diff; a repository `Open Changes` tab renders its changed files as one scrollable multi-diff surface. Multi-diff rows load their bounded document and mount Monaco only near the viewport; a binary or transient per-file failure remains local to that row. The virtual tab key persists the opaque repository ID and repository-relative path so reload can reconstruct the diff without treating it as a writable filesystem document.

For a normal active file tab, Monaco publishes only cursor, selection length, and language identity to Renderer-local Status Bar state. Current-line blame is a bounded, Session-rooted Server Core Git request that selects the deepest approved repository containing the file and returns commit metadata only; diff tabs never masquerade as writable files or issue blame requests.

## Settings, keybindings, and themes

Global `settings.jsonc`, `keybindings.jsonc`, and theme files live in the application data directory. Writes sync a mode-`0600` temporary file before atomic replacement, and in-memory state changes only after replacement succeeds. The Server Core prefers Parcel Watcher hot reload and falls back to polling only these three files. Startup, hot reload, update parameters, get results, and change events share a 256 KiB UTF-8 source ceiling; disk reads stop at that boundary before parsing, and keybinding arrays are capped at 1,024 entries. Schema or size errors retain defaults or the prior valid state and report location without including source text in diagnostics. Missing provider-scoped Agent launch, disabled-by-default lifecycle-hook and output-recovery settings, and the nullable Terminal default cwd are supplied in memory without rewriting an older settings file. Each Agent provider's lifecycle integration can be enabled independently; installation health is a separate typed read/event surface because a saved preference does not prove that a provider loaded or trusted its hook. Provider recovery settings bound pattern count and length plus both input delays; diagnostic exports retain only enablement, delay values, and pattern count. Trusted Domains are a bounded Settings array of normalized HTTP(S) exact origins or explicit subdomain wildcard origins. Server Core owns their JSONC-preserving atomic persistence, while Main alone may append the canonical exact origin selected in a trust prompt; Renderer can manage the complete array only through the ordinary validated Settings update. Object-valued `files.exclude` merges user booleans over bounded defaults, so a default pattern can be disabled with `false` without re-declaring every other default.

The Settings dialog opens in full-width structured UI mode. Its in-app source mode lazily mounts Monaco against the same reducer drafts, and it must parse successfully before returning to structured UI or switching source tabs. Server and Renderer import the same browser-safe Settings and keybinding schemas from `packages/protocol/src/configuration`, so defaults, bounds, and source-to-UI validation cannot drift. Hook installation health describes the last applied settings only: an edited toggle reports `Pending Apply`, and the provider section tells users that Agent Terminals opened before enablement need a restart. View switching is a two-segment UI/Source toggle; the former external `Open Config File` action was removed because macOS has no default `.jsonc` association and the in-app source editor owns config editing.

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

Git operations run via `execFile('git', argv)` with fixed argv constructors and a filtered environment. The only repository mutation exposed to the Renderer is switching to an existing local branch: Server Core resolves the opaque approved repository ID, re-lists its bounded local refs, and invokes `git switch -- <branch>` only after an exact match. There is no arbitrary checkout, fetch, reset, discard, or command surface. One Server Core-wide semaphore admits at most eight Git subprocesses, metadata commands cap output at 4 MiB, and bounded file-diff commands retain the configured file-size cap. A shared Server Core resolver checks the GUI PATH, then reads only a bounded marker-prefixed PATH from the login shell; it caches validated absolute executables and revalidates stale entries. Agent adapters, Agent PTYs, version probes, and the fixed Project Status allowlist (`gh`, `vc`, `linear`) use this resolver and its filtered environment without inheriting the rest of the shell environment. Claude Code integration reads only compact live-session metadata: at most 512 candidates, eight reads at once, and no more than 128 KiB from any file. Codex integration locates state beneath the documented `CODEX_HOME`/`CODEX_SQLITE_HOME` roots and queries a capability-detected thread index read-only; neither adapter opens transcripts. Available title, session ID, activity, and usage metadata are correlated with the persisted cwd of the matching provider Terminal. A provider-owned Agent session ID may be claimed by only one Terminal; unbound probes exclude IDs already claimed by another Terminal and IDs discarded by a restart. Every new Session starts with the automatic sidebar title `Untitled`, while its first Terminal keeps the provider-specific `Shell`, `Claude Code`, or `Codex` title. The first Agent Terminal becomes the Session's primary Agent Terminal and exclusively owns later automatic sidebar-title promotion from useful metadata; later Agent Terminals retain independent metadata without replacing it. Manual rename is serialized per Caxri Session and targets that exact primary binding. Codex 0.110.0+ within major 0 uses the bounded App Server `thread/name/set` method, and Claude Code 2.1.232+ within major 2 uses a bounded non-interactive `/rename`; older, unknown-major, or unverifiable versions fail closed, and Caxri never writes provider-private persistence or injects text into the live PTY. Provider success precedes one SQLite transaction that commits the provider-returned title, the changefeed entry, and the durable command receipt together. A crash before that transaction can idempotently repeat the same provider rename; after commit, replay returns the stored result without another provider call. The provider's durable resume name changes immediately, but an already-running TUI may retain its cached heading until the next resume because the one-shot sidecar cannot publish into that process. A manual title remains stable across Agent metadata refresh, restart, and primary-Terminal succession. Closing the primary promotes the next Agent Terminal. Missing or changed storage produces `unknown`; it never interrupts PTY input/output or resets a known Session title.

`Terminal.title` is the stable semantic title: Agent metadata promotes it to the conversation title,
while Shell OSC 0/2 remains isolated in the live `Terminal.ptyTitle`. Once a Terminal binds an Agent
provider, Server Core discards later OSC titles instead of persisting or broadcasting state with no
consumer. A directly managed Agent Endpoint uses the provider catalog title until metadata
establishes an `agentSessionId`, then uses the conversation title on later generations. Endpoint
names are fixed when a generation begins; Caxri does not expose a dynamic rename protocol.

A Shell Terminal can become an Agent Terminal when its unpublished input line launches `claude` or
`codex`, either directly or through a shell alias. Terminal Host keeps a simple-command candidate in
memory for a bounded window and confirms aliases from the PTY's active foreground process group using a
fixed, bounded `ps` query; compound commands and background processes are excluded. Once the provider
executable is confirmed, Server Core promotes the durable Terminal atomically so its shared icon and
title update even before the provider writes session metadata. A later same-Project, unclaimed metadata
session created after command submission supplies the Agent session ID and generated title. Shell input
and process-list output are never logged or persisted, and ordinary output alone does not infer Agent
identity.

Each directly launched Agent PTY generation receives an independent, short-lived Agent Endpoint ref
and token after Server Core has resolved its Project, Session, Terminal, provider, and launch configuration.
The filtered PTY environment carries the credential only for that direct launch; Server Core never persists
the token or publishes it through events, diagnostics, snapshots, or command output. Provider launch
evidence classifies only the built-in executable with an empty argument list as `standard`, exact
documented bypass flags as `elevated`, and custom executables or arguments as `unknown`. Endpoint
selectors use the opaque ref; duplicate display names never redirect a mutation to a newer generation.

Peer messages are Server Core-owned, generation-scoped, bounded plain text. Their bodies exist only in the
live in-memory Inbox and never enter SQLite, logs, diagnostics, the event journal, Terminal
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
Server Core persists a dispatch receipt before a fresh Terminal or resumed PTY can spawn, fences resume
to the Terminal's exact provider session binding, and reports lifecycle changes from process events
without reading output or silence. Server Core and Terminal Host both revalidate an exact Endpoint generation
before an interrupt or stop reaches the current Caxri-owned PTY. A client disconnect explicitly
cancels its dispatch long poll.

`terminal.send` requires a Desktop or human CLI owner with `terminals.steer`. Its text is bounded by
UTF-8 bytes, rejects C0/C1 controls except Tab, and adds Enter only through the explicit flag. It
shares the existing content-free PTY input metrics and logs only target, byte count, and Enter state;
it never claims peer origin. Explicit message `--wake` requires both dispatch and control authority,
resumes only a bounded tombstone for the exact stopped generation, confirms the replacement Endpoint,
then admits the message under the same request identity. See `docs/agent-command-authority.md`.

Each Endpoint also exposes one typed messaging capability (`deliveryMode`, `health`, stable `reason`,
`checkedAt`, and `nextAction`). The Server Core probes the configured executable and version behind a
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
Pull `wait` and `check` consume only after the authenticated Server Core reply flushes; timeout, cancellation,
or disconnect requeues the same FIFO message. The controlled version matrix and operator behavior
are recorded in `docs/provider-messaging.md`.

Provider lifecycle hooks follow one generic Server Core contract: provider-local adapters define documented events, config targets, schema inspection, render, and removal, while `apps/server/src/domains/agents/hooks/` exclusively owns filesystem reads, a cross-process install lock, mode-`0600` atomic replacements, debounced provider-config watching with a slow polling fallback, bridge staging, the authenticated local socket, and health reporting. Adapters add content-free turn, attention, shell-tool, and completion phases; Codex additionally binds its documented `SessionStart` to the activity-neutral `sessionIdentified` phase and its `PreCompact` / `PostCompact` pair to `compactionStarted` / `compactionFinished`. `SessionStart` covers startup, resume, clear, and compact before an ordinary prompt exists, so it refreshes exact identity/title without changing Session activity. `shellToolFinished` may revalidate an already selected non-owner Workbench Root so deletion returns the Session to its owner; it never records topology baselines, discovers additions, or emits candidates. Compaction is a Server Core-only Terminal operation projected through the existing record refresh path: it never changes durable Session activity, attention, or unread state, and it clears on `PostCompact`, a standalone Escape accepted by the live PTY, a coordinator-routed `turnStarted`, `attentionRequested`, or `turnFinished` signal, PTY generation retirement, hook-authority loss, or a bounded five-minute timeout. Escape-prefixed editing and navigation sequences are not cancellation. The bridge extracts only the opaque provider session identifier from provider stdin; commands, arguments, prompts, output, and transcripts are discarded before the signal crosses the bridge. Foreign hooks and comments are preserved, malformed trees and policy-disabled configs fail closed, Codex inline-hook conflicts are reported instead of merged, and removal independently preserves every newer marked schema even when another conflict is present. Desktop Main supplies the fixed per-user bridge root; tests omit it by default, while focused Electron coverage may opt into an isolated user-data hook root with `CAXRI_E2E_AGENT_HOOKS=1` so it cannot mutate real CLI configuration.

Provider hook intent is profile-scoped while provider configuration is user-global. The shared hook root persists a versioned union of enabled providers and paths by Caxri profile, prunes entries whose real profile directory was explicitly removed, and installs the remaining union under the same cross-process lock; one profile can remove a provider only after no recorded profile still enables it. This prevents independently configured worktrees from uninstalling each other's hooks, continuously rewriting the global provider files, or leaving an unremovable intent after profile cleanup.

The staged hook command path and arguments stay stable across ordinary application upgrades so provider trust does not churn; bridge implementation upgrades happen behind that path. A hook process reads provider stdin only to extract the opaque session identifier (bounded, never content), emits no prompt or response content, and sends only provider, phase, schema, Terminal, PTY generation, token, and that optional session identifier (capped at 256 characters) over a mode-`0600` Unix socket. A globally installed bridge stays silent when no live Caxri socket exists, including when a detached child inherited stale launch context; failures after reaching a live Caxri listener are reduced to fixed content-free stderr reasons. Server Core records content-free accepted, ignored, and rejected outcomes with stage and outcome-specific available fields: reason, provider, phase, Terminal, and only a boolean indicating whether session identity was present. Repeated accepted/ignored phases are logged once per PTY generation to bound routine hook volume. Tokens, environment values, session IDs, prompts, responses, and transcripts never enter diagnostics. Server Core accepts a signal only when its random token, independently established provider binding, schema, Terminal, and current generation all match; inheriting a token cannot promote a Shell Terminal, and an authenticated signal for a provider the Terminal does not own is acknowledged as ignored rather than misreported as a failure. Startup removes a bounded set of same-profile socket paths whose encoded Server Core PID no longer exists. A validated attention-bearing hook phase is authoritative for Session activity/unread state until the next `turnStarted`, which updates activity and restores metadata attention as a fallback if that turn's later hook is lost. Capability-detected metadata remains authoritative for title and usage; Agent session identity follows metadata until a validated signal names a different provider session (a manual in-terminal resume), which rebinds the Terminal, invalidates in-flight probes, and schedules a fresh metadata read. A probe with no identity preserves that exact binding until a new launch explicitly resets it. Exact authenticated hook identity may intentionally bind multiple Terminals to the same provider session; only heuristic discovery excludes identities claimed by another Terminal. While hook authority is established later probes cannot overwrite hook activity or clear the resume binding. Disabling a provider immediately ignores later signals in that profile; only the last disabling profile removes current/older Caxri entries globally. Existing PTYs that predate enabling may need a restart to inherit the bridge environment.

The Source Control view treats the active Workbench Root repository, linked worktrees, nested repositories, and initialized submodules as independent status scopes. Its Working Tree view uses the current index and filesystem, while its lazy Pull Request view asks `gh pr view` for the current branch's validated base/head object IDs and diffs that committed range without mixing in local working-tree changes. Repository discovery uses structured Git output, coalesces concurrent summaries, and passes an opaque repository ID back for diff requests. `git.diffDocument` returns bounded original and working-tree text for Monaco without exposing an arbitrary Git command or weakening repository containment. Nested roots inherit the containing Workbench Project grant. A linked worktree outside that root becomes eligible only after a native folder-picker grant authorizes its exact canonical path as a Project; Git discovery never expands durable path authority by itself.

Automatic worktree attribution requires an explicit report from the authenticated, generation-scoped Agent Endpoint after that Agent creates the worktree. Server Core records structured Git topology for the owning repository before the prepared Endpoint can spawn, then forces a fresh structured topology read when Server Core forwards the exact Endpoint summary and canonical path. The report is accepted only when Endpoint, Terminal, Session, owner Project, provider, repository identity, baseline absence, and one current linked-worktree path all agree. Missing or stale identity, a failed Git read, a pre-existing path, or topology alone fails closed without a prompt, selection, or Project authorization. The bundled CLI exposes only this narrow report; transcripts, provider-private state, Terminal output, and arbitrary shell execution are not provenance inputs.

Each approved Git scope also exposes lazy, independently pageable commit history through its opaque repository ID. Server Core parses fixed NUL-delimited `git log` fields, caps page size and offset, and accepts only an existing, non-symlink path contained by that repository for optional subtree history. Selecting a commit issues a separate read-only metadata/file-list request; merge commits compare through their first-parent history, file results are bounded, and no history request exposes checkout, reset, fetch, or another mutation.

The bundled Project Status extension is lazy: opening its ViewContainer activates its TreeDataProvider and asks Server Core, through the public capability-scoped `caxri` API, to combine the approved primary repository and initialized submodules with GitHub PR/check data, deliberate Linear references from the PR body, and Vercel deployments. The always-visible Status Bar uses a separate lightweight primary-repository overview: it reads Git changes plus the origin and current GitHub PR, never triggering Linear or Vercel, and file events refresh only `git.summary`. Its branch picker lazily lists the approved primary repository's local refs and uses the narrow switch operation above; its additions/deletions are the tracked working-tree diff against `HEAD`, while untracked files remain visible in Source Control without synthetic line counts. Server Core invokes `gh`, `linear`, and `vc` only through structured argv arrays, filtered environment inheritance, timeouts, and bounded output; Renderer receives validated read models and never CLI access. Tree tooltips cross the Extension Host boundary as either bounded plain text or bounded structured rows; structured URLs admit credential-free HTTP(S) only, render through an interactive Renderer hover card, and still use Main's trusted-origin policy. Missing tools, authentication, links, rate limits, and timeouts stay scoped to the relevant surface.

## Security

BrowserWindows use `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, a restrictive CSP, blocked navigation, and denied new windows. Renderer may request only an HTTP(S) external open; Main re-parses and canonicalizes the URL, rejects credentials and unsupported protocols, and owns every system-browser call. Loopback origins are trusted by default. A configured exact origin or explicit wildcard matches only the same scheme and port; malformed rules fail closed. Every other origin requires a native confirmation, and choosing trust persists its canonical exact origin before opening. Passive navigation and new-window attempts remain denied rather than acquiring trust authority. No telemetry or remote upload exists.

Folder-picker results create single-use Main-process grants. A grant is revoked when the Agent choice or Workbench authorization is canceled, expires after 60 seconds if unused, and is consumed before Project creation reaches the Server Core. An automatic worktree candidate carries only an opaque ID to the Renderer; Main claims its canonical Server Core path and accepts a user selection only when its independently canonicalized path is exactly equal. Once a Project exists, new Sessions reference its stable owning ID and cannot submit or broaden a root path. A Workbench selection may reference only an already authorized Project that current structured Git topology proves is a linked worktree of that owner. The Server Core persists the selected root's device and inode, revalidates identity and topology on access/focus/watch failure, and atomically falls back to the owning Project when the worktree disappears or is replaced.

The local Desktop's free-path browser is an explicit-input, developer-tool capability, not a durable
root grant. It exposes only bounded read-only enumeration and one ephemeral file snapshot, and cannot
authorize Files, Search, Git, Terminal cwd, saving, or Project creation. Add Project, Workbench-root
selection, Agent folder selection, and every other workflow that establishes durable root authority
continue to use the native picker and single-use grants above. Remote Clients receive neither the
same-machine free-path capability nor a way to submit a local Client path to Server Core.

## Performance and observability

Desktop Main, Server Core, Terminal Host, and Extension Host record boundary timings for app readiness,
Desktop attachment, first window visibility, Server Core boot, PTY spawn, file listing, Git commands,
Agent probes, and watcher readiness. Concurrent identical file, Git, Agent, and Terminal-start requests
share one in-flight operation so development StrictMode and repeated UI requests do not duplicate
native work. Agent Terminal output schedules a trailing metadata refresh with at most one timer per
Terminal, allowing a CLI-generated title to reach the Primary Sidebar without opening the Info view.
One Agent coordinator owns that scheduling and reads Agent Terminal membership from the durable Terminal
record instead of a cached set, so no lifecycle path can leave the two disagreeing. Ordinary Shell and
dev-server output never enters this probe path; only a bounded simple-command candidate may request
coalesced foreground-process confirmation, after which normal Agent metadata refreshes take over.

Terminal input, resize, and output are high-frequency paths. Successful input and resize requests do not write individual records, repeated ResizeObserver grid sizes do not cross IPC, and Server Core ignores a resize that matches the live PTY grid so a remounted view cannot generate a redundant SIGWINCH. Renderer xterm fits and successful Terminal Host PTY resizes instead emit bounded, content-free burst summaries after 250 milliseconds of quiet or five seconds of continuous activity. Each side records only counts, start/minimum/maximum/final grids, duration, and flush reason, keyed by opaque Terminal identity; summaries never include pixels, output, prompts, commands, source, paths, or environment data. PTY throughput is emitted as periodic aggregate input, output, and dropped-byte counters. The PTY data callback updates only the in-memory parsed screen and live delivery queue; normal lifecycle finalization crosses the parser barrier and writes one bounded screen BLOB instead of persisting raw output periodically. Bootstrap loads all Session state rows in one query and reuses its already-loaded Terminal records to validate every state's Terminal ownership without per-Session reads. A direct aggregate state read batches ownership into one query, while a targeted state read keeps the same read-time repair with one Session-scoped ownership query. Terminal exit, restart/restore, and Agent metadata events refresh only their identified records through one coalesced small read; application attach, Server Core recovery, and structural mutations retain full bootstrap as the convergence path. Monaco stays out of the terminal-first Renderer bundle; after Server Core attachment, a single shared idle preload primes editor-core plus JavaScript, TypeScript/TSX, JSON, HTML, CSS, Markdown, and dotenv tokenization before the first real file selection. Language workers remain demand-loaded.

`benchmark:startup` exercises a representative large repository and requires Server Core, Terminal, Files, and Git to become usable within three seconds. It also validates timed log coverage, zero request/watcher failures, aggregated terminal metrics, and fewer than 256 Server Core file descriptors. `benchmark:editor` separately launches isolated cold and idle-preloaded renderers. The common-language idle preload must complete within three seconds; the first JavaScript or TypeScript document, editor mount, and visible syntax highlight must complete within 250 ms of selection in both paths, and a repeated open must visibly highlight within the same bound.

## Diagnostics and privacy

Structured logs carry timestamp, process, level, event, correlation ID, duration, and the build's application version and commit when known. Diagnostics contain application/runtime versions, redacted metadata/state, counts, and timing summaries. Home paths normalize to `$HOME`; secret-like keys, bearer/API tokens, GitHub tokens, and Slack tokens are redacted. Bundles never include file contents, terminal output/snapshots, environment values, prompts/responses, or agent transcripts.

Structured event names are owned by the browser-safe protocol `logEventCatalog`; production log sinks accept only its derived `LogEventName`, and the `logs.query.event` filter uses the same schema. Query results deliberately keep a bounded string event so older or externally produced JSONL records remain readable without weakening production write-time typing.

GPU failures form one Main-owned correlated incident. Main decodes Electron's raw POSIX child status into the Chromium result code, records selected window state and GPU command-line switches, then captures bounded hardware, ANGLE, Skia/Graphite, and feature status after `gpu-info-update`. The workbench Renderer may report only a strict browser-safe diagnostic union: terminal-renderer status with opaque Terminal identity, renderer enums and counters, process/focus/visibility booleans; or the content-free resize burst summary defined above. Neither branch admits Terminal output, prompts, DOM text, error messages, source, paths, or environment data. Renderer reports immediately before or after a GPU exit are linked through the incident correlation window so post-mortem triage can distinguish a native GPU process loss from a stale xterm atlas or an input-focus failure.

The application version and short commit hash are injected at build time and read once by Desktop Main, which stamps its own logs and forwards them to the Server Core's environment so both processes' logs and the diagnostics export can be correlated to the exact build.

Desktop Main, Server Core, Terminal Host, and Extension Host JSONL files live together beneath the
active runtime profile's `logs/` directory. Development, worktree, E2E, Acceptance, and packaged
launches therefore keep diagnostics attached to the same isolated userData identity as SQLite and
Server state.

CLI `logs follow` resets to a 250 ms poll after output and exponentially backs off idle polling to a
two-second ceiling, avoiding repeated suffix reads and parsing when no new records exist.

## Recovery limits

Renderer or Desktop restart recovers Server-owned state and attaches to live PTYs. Server Core restart
recovers database metadata and persisted snapshots, but operating-system PTYs owned by its retired
Terminal Host are not recoverable in the current lifecycle. Restart attempts are capped and use
exponential backoff; a request that arrives while a crash-triggered Server restart is waiting out its
backoff delay is queued to await that same restart rather than forking early. Startup fails visibly
instead of hanging if Server Core does not become ready within 15 seconds. The frozen public `host.stop`
command is the explicit durable process-shutdown boundary; its legacy method ID is retained to
preserve the A0 command contract, not as an architecture owner name.

A Renderer process crash (`render-process-gone`) reloads the window automatically with backoff (250ms, then 1s, then 4s). After three crashes within a 60-second window, automatic reload stops; Main logs the crash loop and shows a native dialog offering Relaunch or Quit instead of reloading indefinitely.

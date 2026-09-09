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

Desktop notification history is a bounded Renderer-memory projection, separate from Sonner's
live toast queue. Only typed reminder preferences persist in `settings.jsonc`, through the
existing Server-owned scalar settings patch path. History never stores action closures or writes
message bodies to logs or disk. Main forwards accepted Agent banner decisions as transient
`agent.notification` events carrying only Session identity and attention kind; delivery history
uses the existing `projectStatus.alert`. Neither projection raises another popup or replays on
reconnect. Failures and persistent data-loss notices bypass reminder suppression.
See [Notifications](../../../../docs/notifications.md) for the user flow, retention boundaries,
producer ownership, and troubleshooting.

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
recovery. Desktop Main is otherwise replaceable: closing a window revokes its lease and detaches views
without stopping Server Core, Terminal Host, or PTYs. Explicit application quit inspects Server impact:
an idle Server owned only by Desktop stops directly, while live PTYs require a native choice to terminate
tasks, keep them attached in the background, or cancel. A Renderer reload attaches to the same Server
state and bounded Terminal snapshots. A Server Core crash causes its coupled Terminal
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
or schema table. Protocol source is grouped behind seven domain barrels:
`agent`, `configuration`, `desktop`, `domain`, `mobile`, `registry`, and `transport`; the package root is the
only public package entrypoint. Do not add or remove one of those domains without updating this
reference and `scripts/__tests__/workspace-contract.test.ts`.

`packages/system` stays free of product domain state and native Desktop dependencies. It owns
reusable process, filesystem, observability, build, and test-harness primitives for non-browser
consumers.

`packages/utils` is browser-safe and free of runtime dependencies. It holds pure functions only.
Domain types, protocol schemas, and React code never move there.

`packages/mobile-transport` is the browser-safe cryptographic and wire-format boundary shared by
native mobile clients and the Server gateway. It cannot import Node.js, Electron, native Desktop
packages, or application source. Its public package root is the only supported entrypoint.
Device revocation first fences the stored Server generation, then sends a generation-bound `revoked`
control payload only through each already authenticated encrypted session before disconnecting it. The
mobile client clears its credential only after that sealed payload authenticates. A reconnect whose
stored credential cannot authenticate remains indistinguishable from an invalid credential or fake
endpoint, so it retains the credential, stops automatic retry, and asks the user to retry or forget it.

`apps/mobile` is the Expo and React Native companion application. Its `app/` and `src/` runtime graph
may import only `@caxri/mobile-transport` and `@caxri/protocol`; tests may additionally consume
browser-safe pure utilities. Runtime type-checking exposes only ECMAScript plus worker-safe Web APIs,
excluding both Node.js ambient types and browser document/window globals that React Native does not
provide. Node-powered Expo plugins and build scripts remain outside that runtime configuration.

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
An invalid internal event is rejected inside the Server Core listener before it can reach a structured control or
journal boundary. The rejection records only its known event name plus bounded schema paths, codes, and array counts,
then emits the existing full unknown-state invalidation so connected clients converge without crashing Server Core or
exposing the rejected payload.

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
- `sessions`: Project ownership, identity, creation/visit timestamps, the allowlisted Session Activity clock and reason, independent sidebar order, reversible archive time, primary Agent Terminal and Agent Activity state, attention generations, layout version, and automatic/manual title ownership

- `terminals`: durable identity/position/cwd/title/icon/provider and last process state
- `terminal_snapshots`: versioned bounded VT/text payload with source grid, line, and byte counts
- `session_state`: versioned open editor tabs, active tab, desired Secondary Sidebar ViewContainer ID, recursive Terminal split layout, and the last durable file-mutation editor-remap operation ID so at-least-once recovery stays idempotent across Renderer reloads; invalid JSON, invalid shapes, or unsupported versions repair to a default layout and emit a content-free warning instead of failing bootstrap
- `app_state`: last selected Project and Session, window state, active theme, and schema version

Session sidebar order is explicit within each Project. A relative `session.reorder` command moves one
active Session before or after another active Session in that same Project, inside the structural
command transaction. It never changes activity or visit timestamps. Each existing meaningful activity
write atomically promotes only its affected Session by updating the sidebar position alongside the
activity clock; new Sessions start first. Renderer freezes the displayed sequence during a drag but
does not suspend Server activity writes or replay earlier activity after the drop. Navigation and
Server fallback selection share the sidebar comparator; actual activity history remains independent.

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

Terminal file-link detection forwards the raw text, owning Terminal ID, and optional editor location
without giving Renderer filesystem access. Server Core tries exact absolute, current Workbench Project,
and persisted Terminal-cwd candidates first. When an ordinary relative path is incomplete, a bounded
directory suffix search may resolve it only inside the current Workbench Project; one complete
result opens directly, while incomplete or ambiguous results require the Renderer candidate picker.
An explicit `.../` prefix opts into the same bounded suffix search across every authorized Project.
Current-user `~/...` links expand only in Server Core, which rejects escape and non-regular targets and
reuses a canonical Project that already contains the file. For a Project-contained target Main selects
the unique target Session, creates a no-Terminal Session when none exists, or requires a native choice
when the target Project has multiple reasonable Sessions; that open uses Server Core's one-use Desktop
target, whose approved root/file identity becomes an expected identity that Server Core compares with
its first `files.authorizeOpen` result and revalidates again when Main redeems the target. An explicit
absolute, `file://`, `./`, `../`, or `~/` target outside every Project (OSC 8 hyperlinks carry the
absolute URI even when their label reads `~/...`) is reported as `external` without being read. Main
then reuses the free-path browser's read-only snapshot: it confirms once with Open / Trust Folder and
Open / Cancel, or skips the prompt when the `security.trustedFolders` setting already contains the
file's folder, reads one bounded no-follow snapshot, and the Renderer opens it as an ephemeral read-only
tab in the Terminal's own Session. Trusting a folder persists only that prompt-skip preference; it never
creates a Project, grants Files, Search, Git, Terminal cwd, or save authority, or makes the tab durable.
Home expansion and suffix search never create a permanent single-file exception or a Renderer filesystem
capability.

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

Terminal groups form a persisted binary split tree with horizontal or vertical direction and a bounded
ratio. Dragging a tab moves its durable Terminal ID between groups or creates a new split; shared
reducers collapse empty groups and validate that one Terminal cannot appear twice. Moving a view may
detach and reattach xterm, but the Terminal Host-owned PTY is neither restarted nor duplicated.
Keyboard-adjustable separators and group labels preserve accessible focus semantics.

The active Terminal's Status Bar metrics are sampled by Terminal Host. A fixed `ps` argv reads only PID,
PPID, and RSS for the live PTY process tree every two seconds while that Terminal is visible; Renderer
receives aggregate memory and descendant count, never commands or environment data. Sampling stops when
a file tab is active and an exited PTY returns no usage.

Default `Command+K`, `Command+T`, and `Command+W` bindings clear the active xterm view, create a Terminal in the active group, and close the active Terminal through its normal lifecycle. `Command+Shift+Enter` configures Tab followed by LF when a Terminal owns focus; the VS Code-compatible `sendSequence` command normalizes that LF to Return before accepting the active completion and submitting it. Clear is Renderer-local and never sends input or a signal to the PTY. All bindings remain configurable, and app-wide commands are ignored while a modal dialog is open. Command-backed native menu items derive placement, ordering, labels, and accelerators from the shared command catalog and live keybindings; only standard Electron role items stay explicit in Main. Static command descriptors default to Renderer-registry execution and explicitly mark View-catalog execution so tests can prove that every shared command has exactly one route. Released default-keybinding generations remain compatibility fixtures: reviewed migrations must resolve their persisted command IDs to the current executable catalog without rejecting extension or user-defined commands. The Server Core owns the unified ViewContainer/View/Command descriptor catalog. Builtin React surfaces and extension Tree Views use the same selection, command, and persistence path; Renderer only dispatches the descriptor's `viewKind`.

`workbench.action.terminal.sendSequence` is an argument-required keybinding command: `args.text` is decoded by JSONC, normalizes CRLF and LF to Return like VS Code's `sendText`, and sends every other byte unchanged through the existing typed `terminal.input` path to the active PTY. `sendSequence` stays bounded to 65,536 characters, while direct xterm input accepts one bounded 1,048,576-character payload and Server Core splits it into ordered, surrogate-safe private Host requests. The lower-level `terminal.input` contract remains byte-preserving so direct xterm input, Ctrl+J, and multiline paste keep their original meaning. Keybindings may use the `terminalFocus` context so the chord falls through outside xterm. Contextual bindings are dispatched in the Renderer and do not become Electron native-menu accelerators because Main cannot evaluate DOM focus; source order remains authoritative, and the first binding whose context matches wins. Argument-required commands stay out of the Command Palette and cannot be added as an incomplete binding by the structured shortcut editor, but a complete source-authored binding remains visible and its chord remains editable there.

The Agent Actions picker targets one captured, running Agent Terminal. A typed `agentActions.list` read asks Server Core to derive provider-owned discovery roots from the Terminal's durable provider, cwd, and authorized Project; Renderer cannot submit a filesystem root. Server Core traverses only bounded canonical roots, rejects symlink escape, reads bounded scalar frontmatter metadata without returning source bodies or paths, then applies provider defaults, discovered items, and explicit user overrides in that order. The resulting list is capped at 256. Insert and run both reuse the existing structured `terminal.input` method as append-only PTY writes. An exhaustive provider-and-action-kind plan sends inserts, commands, and Claude Code skills in one write; Codex skills use one invocation write, a 150ms paste-burst settle window, then a Tab-plus-Return write to accept the completion and submit the composer. No method reads, clears, or replaces the current draft. See [Agent Actions](../../../../docs/agent-actions.md).

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

File explorer, path-browser, and editor navigation trust links reached through the Session's Project root, including external targets. File reads, saves, listings, and open authorization keep the normalized workspace entry as the document identity while using the canonical target for filesystem operations and operation-queue ordering. Direct outside paths remain unauthorized. Saves preserve the workspace link and validate temporary files against the canonical target directory. Other filesystem operations retain canonical Project containment and their existing mutation restrictions; replaced Project roots and text/size violations remain rejected. Saves hold the validated inode open with `O_NOFOLLOW`, write and sync a same-directory temporary file, revalidate the target identity, then atomically rename the complete replacement over it and sync the directory; an interrupted save therefore leaves either the old full bytes or the new full bytes. Following VS Code's local disk-provider boundary, create, recursive copy, rename, and move use asynchronous Node filesystem APIs inside Server Core. Server Core coordinates document reads, saves, and mutations through one bounded path-aware scheduler: overlapping paths remain ordered, unrelated files continue during long operations, and recursive copies are serialized per Project. A document request that waits too long is canceled inside that scheduler before its filesystem operation starts; Main therefore leaves saves pending for Server Core's authoritative result instead of reporting a timeout while a write can still execute. Server Core revalidates source and target identities before mutation, rejects root changes, symlinks, hard-linked regular files, conflicts, and directories copied or moved into themselves, and reserves target paths so concurrent Caxri requests cannot select the same name. Recursive copies preflight a bounded manifest for entry count and aggregate bytes, then use abortable Node file-handle streams so the operation deadline covers active transfer. A failed copy preserves its partial target because Node cannot atomically bind pathname deletion to a validated inode; structured failure records report the safe aggregate counts, duration, and operation phase without risking deletion of a foreign replacement. Source entries, destination directories, and created parent directories are revalidated throughout the copy. Path-based rename performs a final conflict check and Caxri-local reservation; Node has no atomic no-replace directory rename API, so an external process can still win the final path race. Keeping these narrow VS Code-aligned pathname limitations is an explicit tradeoff of the Node-only implementation. Cut/copy state is Renderer-local metadata scoped to one Project, while Server Core reauthorizes the source and target on every paste; copy/duplicate and cut-paste choose a bounded collision-free suffix. The Renderer coalesces repeated long copy or move intents, exposes an accessible pending status, disables duplicate triggers until completion, and reports success or failure. Main reveals an item in Finder only after Server Core authorizes the current Project-local regular file or directory. `Open in Terminal` supplies an optional cwd to `terminal.create`; Server Core canonicalizes it, requires a directory beneath that Session's Project root, captures its inode, and revalidates that identity in `TerminalManager` immediately before each path-based node-pty spawn, including restart and restore. A final check-to-spawn race remains because node-pty accepts only a cwd pathname; this is the same explicit Node-only local-filesystem tradeoff, not a descriptor-backed sandbox boundary. For Trash, Main shows the native recovery warning, repeats Server Core inode and Project-root authorization after confirmation, and then calls Electron's path-based `shell.trashItem`; there is no permanent-delete fallback. Successful mutations invalidate affected file-tree queries for every Session sharing the Project. Successful renames and moves also remap normal editor tabs, independent dirty buffers, and in-flight reads or writes for the item and its descendants across those Sessions; successful Trash operations close affected tabs and discard pending document completion across the same scope. Directory identity is revalidated around enumeration so a path swap cannot disclose another directory, and entry metadata reads use a bounded worker pool. Directories are lazy-loaded. Identical concurrent directory reads share one bounded Server Core producer; cancellation stops only that caller's wait and never aborts another caller that joined the same read. The `Cmd+P` path browser uses a separate bounded `files.browse` request to scan only its current Project-local directory; navigation cancels stale Session scans and active scans share a small Server Core-wide concurrency budget. Only when a typed relative directory does not exist does Main fall back once to `files.locateDirectory`, the same bounded, exclusion-aware suffix traversal Terminal link resolution uses; Server Core picks the shallowest matching Project directory and Main lists it after revalidating that it is still inside the Project root; ordinary browsing never triggers a Project-wide traversal. Browse describes regular entries from the opened directory handle's metadata alone, while tree listings still stat each entry for its size; a symlink entry in either listing is the one deliberate relaxation, receiving a single type-only follow through the listing's shared timeout budget so the row can show a folder or file icon (the same follow VS Code's disk provider takes), while opening and expanding trusted workspace links are separate requests that resolve the current target; link-entry copy, move, rename, and Trash retain their existing restrictions. File-tree visibility follows the global VS Code-style `files.exclude` glob object and never reads `.gitignore`; dependency and build directories remain visible by default. `@parcel/watcher` uses the native recursive macOS backend, independently ignores VCS internals and dependency/build caches, coalesces bursts, and watches the active root only. Polling is inactive while that backend is healthy; a bounded fallback starts only after native setup or delivery fails and polls the active root plus expanded directories that are not excluded by the watcher traversal policy. A normal watcher batch reloads only the directory that directly owns a changed path, while overflow reloads all visible directories and switching Session identity intentionally resets expanded absolute paths. Native watcher subscriptions still cover the Project root only; changes made externally to out-of-root link targets are not guaranteed to generate Project file events.

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

Project search is a Session-scoped Server Core read, never a Renderer-supplied root or command. The standalone Server bundles a platform-specific ripgrep executable and invokes it by absolute artifact path with structured arguments, `--no-config`, hidden files enabled, and an independent fixed traversal policy for VCS metadata, dependencies, and build caches rather than `files.exclude` or repository ignore files. Ripgrep only enumerates candidate paths. A terminable Worker revalidates every candidate's canonical Project containment and file identity, rejects symlinks and hard-linked regular files, opens content with `O_NOFOLLOW`, skips binary and oversized documents, and performs JavaScript matching so existing regular-expression and UTF-16 column semantics remain stable without blocking Server Core. The parent owns the shared deadline, file, match, snippet, and total IPC payload limits; at most four Project searches execute across Sessions, and cancellation, timeout, result, payload, and file limits terminate the child process or Worker with an explicit reason. A newer search aborts the prior search for that Session; the Renderer also keys results by the complete query so a stale response cannot replace a newer query, and it never presents an incomplete empty result as definitive `No results`. Content options cover case, whole word, regular expression, include, and exclude matching, while Monaco reveal intents remain keyed by the Session-specific model URI.

External disk changes always replace an open buffer, including a dirty buffer. This is a deliberate product choice for agent-driven workflows; the Renderer clears dirty state and shows a non-blocking notice rather than opening a conflict dialog. Editor buffers and Monaco model URIs are keyed by Session identity as well as path so Sessions sharing one root cannot reuse each other's dirty state. The Renderer document cache is the sole source of dirty truth because SQLite does not persist unsaved bodies: durable Session tabs are always clean, while a Server Core-only restart reconciles its clean snapshot with surviving Renderer documents before preview replacement or dirty indicators read it. A full Renderer/application restart has no recoverable dirty body and therefore resumes from clean disk state; legacy durable dirty flags are normalized on read. The Renderer reconciles a transient motion identity per Session so clean preview replacement and pinning preserve one visual tab instance, while actual add/close still enter or exit. Clean document contents share a 32 MiB Renderer cache budget across Sessions; dirty buffers are the only exception because reclaiming them would lose unsaved work, and they displace clean buffers first. Closed models do not retain Monaco view state. When a Session becomes active again, cached documents are compared with current disk version metadata; only actual disk changes replace its inactive dirty buffers.

Git file selections open read-only virtual editor tabs instead of embedding patch text in the Inspector. A single-file tab renders a Monaco side-by-side diff; a repository `Open Changes` tab renders its changed files as one scrollable multi-diff surface. Multi-diff rows load their bounded document and mount Monaco only near the viewport; a binary or transient per-file failure remains local to that row. The virtual tab key persists the opaque repository ID and repository-relative path so reload can reconstruct the diff without treating it as a writable filesystem document.

For a normal active file tab, Monaco publishes only cursor, selection length, and language identity to Renderer-local Status Bar state. Current-line blame is a bounded, Session-rooted Server Core Git request that selects the deepest approved repository containing the file and returns commit metadata only; diff tabs never masquerade as writable files or issue blame requests.

## Settings, keybindings, and themes

Global `settings.jsonc`, `keybindings.jsonc`, and theme files live in the application data directory. Writes sync a mode-`0600` temporary file before atomic replacement, and in-memory state changes only after replacement succeeds. The Server Core prefers Parcel Watcher hot reload and falls back to polling only these three files. Startup, hot reload, update parameters, get results, and change events share a 256 KiB UTF-8 source ceiling; disk reads stop at that boundary before parsing, and keybinding arrays are capped at 1,024 entries. Schema or size errors retain defaults or the prior valid state and report location without including source text in diagnostics. Missing provider-scoped Agent launch, disabled-by-default lifecycle-hook and output-recovery settings, and the nullable Terminal default cwd are supplied in memory without rewriting an older settings file. Each Agent provider's lifecycle integration can be enabled independently; installation health is a separate typed read/event surface because a saved preference does not prove that a provider loaded or trusted its hook. Provider recovery settings bound user pattern count and length plus both input delays; diagnostic exports retain only enablement, delay values, and the user-authored pattern count. Trusted Domains are a bounded Settings array of normalized HTTP(S) exact origins or explicit subdomain wildcard origins. Server Core owns their JSONC-preserving atomic persistence, while Main alone may append the canonical exact origin selected in a trust prompt; Renderer can manage the complete array only through the ordinary validated Settings update. Trusted Folders follow the same shape for absolute POSIX directory paths: Main alone may append the parent folder confirmed in a Terminal external-link prompt, and a matching folder only skips that prompt for later read-only opens. Object-valued `files.exclude` merges user booleans over bounded defaults, so a default pattern can be disabled with `false` without re-declaring every other default.

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

Git operations run via `execFile('git', argv)` with fixed argv constructors and a filtered environment. The only repository mutation exposed to the Renderer is switching to an existing local branch: Server Core resolves the opaque approved repository ID, re-lists its bounded local refs, and invokes `git switch -- <branch>` only after an exact match. There is no arbitrary checkout, fetch, reset, discard, or command surface. One Server Core-wide semaphore admits at most eight Git subprocesses, metadata commands cap output at 4 MiB, and bounded file-diff commands retain the configured file-size cap. A shared Server Core resolver checks the GUI PATH, then reads only a bounded marker-prefixed PATH from the login shell; it caches validated absolute executables and revalidates stale entries. Agent adapters, Agent PTYs, version probes, and the fixed Project Status allowlist (`gh`, `vc`, `linear`) use this resolver and its filtered environment without inheriting the rest of the shell environment. Claude Code integration reads only compact live-session metadata: at most 512 candidates, eight reads at once, and no more than 128 KiB from any file. Codex integration locates state beneath the documented `CODEX_HOME`/`CODEX_SQLITE_HOME` roots and queries at most 32 capability-detected thread indexes read-only. Ordinary Agent probes never open transcripts. Available title, session ID, activity, and usage metadata are correlated with the persisted cwd of the matching provider Terminal. A provider-owned Agent session ID may be claimed by only one Terminal; unbound probes exclude IDs already claimed by another Terminal and IDs discarded by a restart. Every new Session starts with the automatic sidebar title `Untitled`, while its first Terminal keeps the provider-specific `Shell`, `Claude Code`, or `Codex` title. A probe without a verified provider title leaves that default in place, because the sidebar row already shows the provider icon; only a native notification, which has no icon, substitutes the content-free `Claude Code session` or `Codex session` derived from the Terminal's provider alone. Naming and rename both treat the default as an absent title rather than as a current name. The first Agent Terminal becomes the Session's primary Agent Terminal and exclusively owns later automatic sidebar-title promotion from useful metadata; later Agent Terminals retain independent metadata without replacing it. Manual rename is serialized per Caxri Session and targets that exact primary binding. Codex 0.110.0+ within major 0 uses the bounded App Server `thread/name/set` method, and Claude Code 2.1.232+ within major 2 uses a bounded non-interactive `/rename`; older, unknown-major, or unverifiable versions fail closed, and Caxri never writes provider-private persistence or injects text into the live PTY. Provider success precedes one SQLite transaction that commits the provider-returned title, the changefeed entry, and the durable command receipt together. A crash before that transaction can idempotently repeat the same provider rename; after commit, replay returns the stored result without another provider call. The provider's durable resume name changes immediately, but an already-running TUI may retain its cached heading until the next resume because the one-shot sidecar cannot publish into that process. A manual title remains stable across Agent metadata refresh, restart, and primary-Terminal succession. Closing the primary promotes the next Agent Terminal. Missing or changed storage produces `unknown`; it never interrupts PTY input/output or resets a known Session title.

A bound Codex thread is resolved by its exact provider ID even when its stored cwd belongs to an earlier Worktree.
Unbound metadata discovery still requires the current cwd and a thread created after this Terminal launch. On macOS,
an unbound running Codex Terminal can also establish an old resumed identity through a bounded foreground-process
probe: exactly one valid rollout must be held writable beneath the configured canonical Codex sessions root. The
probe reads process and open-file metadata only, never rollout contents; ambiguous ownership, unavailable tools, and
expired Terminal generations leave the binding unchanged. Lifecycle hooks remain authoritative, and another
Terminal's claimed identity or a discarded fresh-start identity cannot be reclaimed through this fallback.

Codex and Claude Sessions receive one Caxri-generated title after an authenticated main-turn completion supplies
useful conversation context. The naming service reads a bounded, provider-authorized transcript tail in Server memory,
selects visible user and assistant messages, and excludes instructions and tool records. It never uses Git branch
names. Unclear tasks defer naming; generation uses the existing isolated, tool-disabled provider text runner.
`sessions.automatic_naming` persists the exact provider binding and pending title before native rename, then records
the provider-returned title and completion. Automatic and manual writes share the Session rename queue. Every async
boundary revalidates manual intent, archive state, primary binding, cwd, and launch identity; old work never follows a
new Agent binding. Matching pending readback completes a recovered intent without repeating `/rename`.

Completion ends generation for that Caxri Session, including after restart. Later native metadata may synchronize a
name but never triggers another write. Claude's transcript `custom-title` outranks `ai-title` and stale live metadata;
only `nameSource: user` is an explicit metadata fallback. Newer explicit external renames acquire manual ownership,
while AI titles and pre-write snapshots cannot undo Caxri's completed rename. Codex does not persist title provenance:
its later native name is synchronized without guessing who changed it. A first-turn native manual rename cannot be
distinguished from an automatic title; a manual rename through Caxri is always protected. Codex's provisional
first-prompt prefix remains filtered inside the native SQLite query, so raw prompts never become displayed names.

Manual rename remains user-owned. `session.rename` resolves the exact
primary Agent identity, sends the new name through the provider's public rename boundary, and commits the
provider-authoritative result to SQLite inside a per-Session queue so a slower earlier request cannot overwrite a newer
one. It sets `title_mode` to `manual`, which stops the metadata probe from replacing the user's title with a later
provider-native one.

Long-paste summaries and automatic titles use a macOS `sandbox-exec` profile that
denies reads of the Project root and of the global instruction files the CLI offers no switch for (`AGENTS.md` and
`AGENTS.override.md` for Codex, `CLAUDE.md` and `CLAUDE.local.md` for Claude), because an isolated working directory
alone cannot reach a file the CLI resolves from its own configuration directory. Pasted text and model output never
enter logs, events, diagnostics, SQLite, or UI.

Every managed Agent inherits the public, non-authorizing `CAXRI_MANAGED_AGENT=1` marker, which a user's own hook script
may read to skip its work inside Caxri. A personal provider hook — including a personal session-naming hook — is
preserved untouched across install and removal; Caxri owns only its own marked entries.

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

An Agent Terminal keeps one interactive Shell as its PTY root and starts the configured Agent as a managed
foreground child. The Shell process defines the Terminal lifecycle, while `lastAgentProcessState` records
whether an interactive Agent is starting, running, or stopped in that Terminal; managed control is fenced
separately by the in-memory launch ID and Agent process ID. Agent exit therefore returns to the same live Shell
without emitting `terminal.exit`; only the Shell root exiting stops the Terminal. Durable
provider, title, and Agent session identity remain attached to the Terminal so a later explicit resume can
start another managed generation. A manually launched foreground Agent receives no managed identity or control;
bounded process probes only publish and later revoke its interactive availability.
Long-paste preparation returns an explicit native-paste result for these manually launched Agents before
saving or summarizing text. Managed Agents retain generation-fenced summaries and file-reference fallback;
preparation errors never trigger native-paste fallback. Managed startup supports zsh and bash; when the configured platform Shell is
unsupported, Agent Terminals use macOS's system zsh while ordinary Shell Terminals keep the configured executable.
`terminal.restart`, Resume, and Fresh deliberately replace the Shell PTY too:
injecting a command into an existing prompt could append to an unpublished edit or disrupt foreground job control.
Ordinary Agent exit never replaces the Shell; this explicit restart boundary is the safe exception.

Each managed Agent generation receives an independent, short-lived Agent Endpoint ref and token after Server
Core has resolved its Project, Session, Terminal, provider, and launch configuration. Terminal Host exposes a
mode-`0600` private Unix socket and gives the Shell only a one-time launcher capability. A fixed launcher
claims that capability before user startup files run, receives structured executable, argv, cwd, and filtered
environment fields, removes the capability from the Shell environment, and waits for the Agent child. Endpoint
credentials and the managed hook token exist only in that child plan. The long-lived Shell carries a separate
observation-only hook token; it has no Agent Endpoint or managed-process control authority, and its signals remain
inactive while the managed child owns the current hook generation. Agent
start and exit events carry the exact launch ID so stale generations cannot activate credentials, settle a
newer dispatch, or receive control signals. Server Core never persists a token or publishes it through events,
diagnostics, snapshots, or command output. Provider launch evidence classifies only the built-in executable
with an empty argument list as `standard`, exact documented bypass flags as `elevated`, and custom executables
or arguments as `unknown`. Endpoint selectors use the opaque ref; duplicate display names never redirect a
mutation to a newer generation.

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
Server Core persists a dispatch receipt before a fresh Terminal or resumed managed Agent can spawn, fences
resume to the Terminal's exact provider session binding, and reports lifecycle changes from managed Agent
process events without reading output or silence. Server Core and Terminal Host both revalidate the exact
launch ID before an interrupt or stop reaches the current Caxri-owned Agent child; control never targets the
long-lived Shell root. A client disconnect explicitly cancels its dispatch long poll.

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

Provider lifecycle hooks follow one generic Server Core contract: provider-local adapters define documented events, config targets, schema inspection, render, and removal, while `apps/server/src/domains/agents/hooks/` exclusively owns filesystem reads, a cross-process install lock, mode-`0600` atomic replacements, debounced provider-config watching with a slow polling fallback, bridge staging, the authenticated local socket, and health reporting. Adapters add content-free turn, subagent, attention, shell-tool, tool-batch, and completion phases; Claude binds `SubagentStart` plus `SubagentStop`, while Codex additionally binds its documented `SessionStart` to the activity-neutral `sessionIdentified` phase and its `PreCompact` / `PostCompact` pair to `compactionStarted` / `compactionFinished`. `SessionStart` covers startup, resume, clear, and compact before an ordinary prompt exists, so it refreshes exact identity/title without changing Session activity. Bash `PreToolUse` and `PostToolUse` map to `shellToolStarted` and `shellToolFinished`; Claude's documented `PostToolUseFailure` maps to `shellToolFailed`, while `PostToolBatch` reports when every parallel call in one main-Agent or subagent scope has resolved. A finished shell tool revalidates an already selected non-owner Workbench Root so deletion returns the Session to its owner. The shell phases may also carry a local, bounded classification that the Bash command directly invoked `git worktree add` plus the provider's opaque tool-use identifier. The classification is only intent, and Server Core attributes creation only through the paired Git proof described below. Compaction is a Server Core-only Terminal operation projected through the existing record refresh path: it never changes durable Session activity, attention, or unread state, and it clears on `PostCompact`, a standalone Escape accepted by the live PTY, a coordinator-routed `turnStarted`, `attentionRequested`, or `turnFinished` signal, PTY generation retirement, hook-authority loss, or a bounded five-minute timeout. Escape-prefixed editing and navigation sequences are not cancellation. The bridge extracts only opaque provider identifiers and that boolean classification from provider stdin; commands, arguments, paths, prompts, output, and transcripts are discarded before the signal crosses the bridge. Lifecycle hooks are enabled by default. Before a reconcile writes a provider's file or claims the provider in the shared profile registry, the manager resolves that provider's CLI (the configured launch executable) through the shared executable resolver; a provider whose CLI is missing is reconciled as disabled, reports `notInstalled` with an install hint, and logs `agent_hooks.executable_missing` once per transition. Foreign hooks and comments are preserved, malformed trees and policy-disabled configs fail closed, Codex inline-hook conflicts are reported instead of merged, and removal independently preserves every newer marked schema even when another conflict is present. A packaged release and a worktree dev instance share the same global provider file and the same staged bridge path. The `--schema N` literal in the installed command is only the file's ordering token: a build repairs owned entries with a lower version once and leaves entries with a higher version alone, treating them as healthy. The schema version each instance validates against and the socket it listens on travel only in that instance's `CAXRI_HOOK_*` Terminal launch environment, so a build whose entries were superseded keeps accepting its own signals instead of rewriting the file back. Desktop Main supplies the fixed per-user bridge root; tests omit it by default, while focused Electron coverage may opt into an isolated user-data hook root with `CAXRI_E2E_AGENT_HOOKS=1` so it cannot mutate real CLI configuration.

Claude settings hooks also run inside subagents and include the provider's opaque `agent_id`. The bridge preserves that identifier only to scope the event: Server Core tracks active children within the current Terminal launch, defers a parent `turnFinished` while any child remains, and settles the Session once the final child stops and no parent turn resumes within a 10-second grace window (Claude resumes the main turn itself right after `SubagentStop`, so the resumed turn's own `Stop` normally ends the work). Child-scoped hook activity refreshes the tracked child's liveness, so the fallback measures silence instead of total runtime; only while a parent completion is deferred, a 30-minute all-silent watchdog bounds the case where every completion hook is lost. A new parent turn cancels its predecessor's deferred completion without discarding children that can legally span turns, while Terminal generation retirement, hook-authority loss, provider switches, and Session deletion clear the aggregate exactly. A child-scoped completion cannot directly change parent Session activity or attention, rebind identity, or produce a duplicate unread/system notification.

Provider hook intent is profile-scoped while provider configuration is user-global. The shared hook root persists a versioned union of enabled providers and paths by Caxri profile, prunes entries whose real profile directory was explicitly removed, and installs the remaining union under the same cross-process lock; one profile can remove a provider only after no recorded profile still enables it. This prevents independently configured worktrees from uninstalling each other's hooks, continuously rewriting the global provider files, or leaving an unremovable intent after profile cleanup.

The staged hook command path and arguments stay stable across ordinary application upgrades so provider trust does not churn; bridge implementation upgrades happen behind that path, and the bridge reads the schema version for the invoked provider from `CAXRI_HOOK_SCHEMA_<PROVIDER>` rather than from the command. A hook process reads provider stdin only to extract bounded opaque session, turn, subagent, and tool identifiers and locally classify one bounded Bash command. It emits no prompt or response content and sends only provider, phase, schema, Terminal, PTY generation, token, those optional identifiers (each capped at 256 characters), and an optional literal `true` worktree-create intent over a mode-`0600` Unix socket. The tool identifier crosses only when that intent is true. The command, path, tool output, and remaining provider payload never cross the socket. Server Core waits at most 1.5 seconds for the forced before-topology read, while the bridge gives the complete downstream acknowledgement a two-second socket budget. A topology timeout records no pair; queue or transport delay lets the provider continue, and later attribution still requires a valid captured pair. A globally installed bridge stays silent when no live Caxri socket exists, including when a detached child inherited stale launch context; failures after reaching a live Caxri listener are reduced to fixed content-free stderr reasons. Server Core records content-free accepted, ignored, and rejected outcomes with stage and outcome-specific available fields: reason, provider, phase, Terminal, and only a boolean indicating whether session identity was present. Repeated accepted/ignored phases are logged once per PTY generation to bound routine hook volume. Tokens, environment values, session IDs, subagent IDs, prompts, tool arguments, tool results, responses, and transcripts never enter diagnostics. Server Core accepts a signal only when its random token, independently established provider binding, schema, Terminal, and current generation all match; inheriting a token cannot promote a Shell Terminal, and an authenticated signal for a provider the Terminal does not own is acknowledged as ignored rather than misreported as a failure. Startup removes a bounded set of same-profile socket paths whose encoded Server Core PID no longer exists. A validated attention-bearing hook phase is authoritative for Session activity/unread state until the next `turnStarted` or `turnFinished`; because Claude's `PermissionRequest` omits tool-call IDs, only a `PostToolBatch` for the same main-Agent or subagent scope may move `waiting` back to `running`, after every parallel call in that scope has resolved. Other Agent scopes cannot clear that state, and hook authority remains in force until the turn settles. Capability-detected metadata remains authoritative for title and usage; Agent session identity follows metadata until a validated signal names a different provider session (a manual in-terminal resume), which rebinds the Terminal, invalidates in-flight probes, and schedules a fresh metadata read. A probe with no identity preserves that exact binding until a new launch explicitly resets it. Exact authenticated hook identity may intentionally bind multiple Terminals to the same provider session; only heuristic discovery excludes identities claimed by another Terminal. While hook authority is established later probes cannot overwrite hook activity or clear the resume binding. Disabling a provider immediately ignores later signals in that profile; only the last disabling profile removes current/older Caxri entries globally. Existing PTYs that predate enabling may need a restart to inherit the bridge environment.

The Source Control and Project Status views list only the active Workbench Root repository and its initialized submodules or nested repositories. Other linked worktrees and their children remain outside that summary, even when authorized; the Workbench Root picker owns switching between them. The Working Tree view uses the current index and filesystem, while its lazy Pull Request view asks `gh pr view` for the current branch's validated base/head object IDs and diffs that committed range without mixing in local working-tree changes. Repository discovery uses structured Git output, coalesces concurrent summaries, and passes an opaque repository ID back for diff requests. `git.diffDocument` returns bounded original and working-tree text for Monaco without exposing an arbitrary Git command or weakening repository containment. Nested roots inherit the containing Workbench Project grant. A linked worktree outside that root becomes eligible for selection after an explicit Continue action, a native folder-picker grant, or the user's `continueAutomatically` policy authorizes its exact canonical path as a Project; Git discovery alone never expands durable path authority. The optional `git.fileHead` projection resolves an Editor path inside Server Core and returns its latest touching commit together with that opaque repository ID and repository-relative path, so Editor title actions never duplicate nested-repository path ownership in the Renderer.

Automatic worktree attribution has no CLI, Agent Endpoint, or installed-skill dependency. The launch baseline binds the owning repository and exact Terminal generation. For a locally classified `git worktree add`, the authenticated `shellToolStarted` signal blocks tool execution until Server Core captures a bounded forced topology read; the outcome must carry the same opaque tool-use id, after which Server Core forces one more topology read. Claude failure consumes the pair immediately. Codex does not expose a reliable success discriminator, so a completed outcome proves success only when exactly one linked worktree was added between the paired snapshots. Any overlapping classified windows in one repository are ambiguous even when their outcomes land in different batches; their bounded reservations stay inert until each outcome or TTL consumes them. Capacity overflow temporarily makes all creation attribution fail closed instead of growing the serialized queue. Multiple additions inside one paired window are also ambiguous. A missing or stale launch, missing pair, timeout, failed Git read, pre-existing path, or topology alone also fails closed without a prompt, selection, or Project authorization. Both unique creation attribution and a verified Agent working-directory divergence use one following policy: `ask` prompts, `continueWhenAuthorized` selects existing Projects and prompts for unknown roots, `ignore` does neither, and `continueAutomatically` registers and selects proven roots without prompting. The default remains `ask`. Automatic following rechecks policy, provenance, Session binding, repository topology and root identity before committing registration and selection without another asynchronous gap. The Agent-writable `settings.patch` contract cannot enable `continueAutomatically`; the user settings surface owns this standing authorization. Main still accepts only the opaque candidate ID for manual Continue, and Server Core revalidates that candidate before registration.

Each approved Git scope also exposes lazy, independently pageable commit history through its opaque repository ID. Server Core parses fixed NUL-delimited `git log` fields, caps page size and offset, and accepts only an existing, non-symlink path contained by that repository for optional subtree history. Selecting a commit issues a separate read-only metadata/file-list request; merge commits compare through their first-parent history, file results are bounded, and no history request exposes checkout, reset, fetch, or another mutation.

The bundled Project Status extension activates when its declared badge is queried or its ViewContainer opens. Its badge provider and TreeDataProvider ask Server Core, through the public capability-scoped `caxri` API, to combine the approved primary repository and initialized submodules with GitHub PR/check data, deliberate Linear references from the PR body, and Vercel deployments. The always-visible Status Bar uses a separate lightweight primary-repository overview: it reads Git changes plus the origin and current GitHub PR, never triggering Linear or Vercel, and file events refresh only `git.summary`. Its branch picker lazily lists the approved primary repository's local refs and uses the narrow switch operation above; its additions/deletions are the tracked working-tree diff against `HEAD`, while untracked files remain visible in Source Control without synthetic line counts. Server Core invokes `gh`, `linear`, and `vc` only through structured argv arrays, filtered environment inheritance, timeouts, and bounded output; Renderer receives validated read models and never CLI access. Every one of those invocations passes through a single external-status hub (`apps/server/src/domains/external-status/`): one GitHub pull-request record per `owner/repo#number` is shared by the Status panel, the Status Bar overview, the sidebar delivery badges, and Source Control's pull-request diff, and one circuit breaker per source pauses that source until the reset GitHub reports, persisting the pause under `~/.cache/caxri/` so parallel worktree Servers observe it too. A failed refresh always backs off further than a successful one, and a reserve of GraphQL points is left unspent so the user's own `gh` calls keep working. See `docs/external-status-quota.md`. Tree tooltips cross the Extension Host boundary as either bounded plain text or bounded structured rows; structured URLs admit credential-free HTTP(S) only, render through an interactive Renderer hover card, and still use Main's trusted-origin policy. Missing tools, authentication, links, rate limits, and timeouts stay scoped to the relevant surface.

Extension views opt into numeric activity with manifest `badge: true` and
`views.registerViewBadgeProvider`. The read-only `badge.snapshot` operation shares view activation,
request cancellation, generation fences, and Session/Workbench Root authority with content reads.
Source Control and badge registrations have independent roles on the same view; unload retires both.
Providers emit scoped `badge` invalidation events, never ambient pushes of cached counts. Renderer
queries declared providers before their tabs open, keys results by view/generation/Workbench scope,
and aggregates counts and descriptions onto each owning container. Error, crashed, and disabled
providers contribute no badge. Concurrent activation is coalesced per extension generation. Git
uses the cached full `changedFileCount` summary; Status owns failure aggregation in its extension.

Git diff visibility is independent of file-tree visibility and Git tracking. The bundled Git extension applies
`git.diffExclude` to repository-relative paths when projecting Working Tree, Commit, and Pull Request changes;
Server summaries retain their complete status semantics. A revision-bound, provider-owned header action toggles
temporary visibility within the Source Control scope. Generic Source Control chrome renders optional header
actions without interpreting Git command IDs. Aggregate diff tabs carry only a boolean visibility override and
apply the same shared glob matcher to their fresh data. Hidden changes remain included in total counts and are
identified explicitly; bulk discard is unavailable until hidden changes are revealed.

## Security

BrowserWindows use `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderers, a restrictive CSP, blocked navigation, and denied new windows. Renderer may request only an HTTP(S) external open; Main re-parses and canonicalizes the URL, rejects credentials and unsupported protocols, and owns every system-browser call. Loopback origins are trusted by default. A configured exact origin or explicit wildcard matches only the same scheme and port; malformed rules fail closed. Every other origin requires a native confirmation, and choosing trust persists its canonical exact origin before opening. Passive navigation and new-window attempts remain denied rather than acquiring trust authority. No telemetry or remote upload exists.

Folder-picker results create single-use Main-process grants. A grant is revoked when the Agent choice or Workbench authorization is canceled, expires after 60 seconds if unused, and is consumed before Project creation reaches the Server Core. An automatic worktree candidate carries an opaque ID and a display-only destination path to the Renderer. Choosing Continue submits only the ID: Main claims and canonicalizes its Server Core path, creates a single-use grant, and Server Core revalidates the candidate and linked-worktree topology before registering the Project. Once a Project exists, new Sessions reference its stable owning ID and cannot submit or broaden a root path. A Workbench selection may reference only an already authorized Project that current structured Git topology proves is a linked worktree of that owner. The Server Core persists the selected root's device and inode, revalidates identity and topology on access/focus/watch failure, and atomically falls back to the owning Project when the worktree disappears or is replaced.

The local Desktop's free-path browser is an explicit-input, developer-tool capability, not a durable
root grant. It exposes only bounded read-only enumeration and one ephemeral file snapshot, and cannot
authorize Files, Search, Git, Terminal cwd, saving, or Project creation. Add Project
and Agent folder selection use the native picker and single-use grants above. The Workbench Root
picker discovers all available linked worktrees without registering Projects or emitting Agent
follow prompts. Its explicit authorization confirmation displays the destination and submits only
a worktree ID bound to the repository, Session, canonical path, device, and inode. Main resolves
that ID through fresh Server topology and consumes a single-use grant; Server checks the ID again
before registration. Unknown creation times remain unknown; ordering uses the linked checkout's
`.git` pointer birth time, never its changing modification time. Detected Agent worktrees use
explicit Continue or the user's standing automatic-follow policy described above. Remote Clients
receive neither the same-machine free-path capability nor a way to submit a local Client path to
Server Core.

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

Terminal input, resize, and output are high-frequency paths. Successful input and resize requests do not write individual records, repeated ResizeObserver grid sizes do not cross IPC, and Server Core ignores a resize that matches the live PTY grid so a remounted view cannot generate a redundant SIGWINCH. Renderer xterm fits and successful Terminal Host PTY resizes instead emit bounded, content-free burst summaries after 250 milliseconds of quiet or five seconds of continuous activity. Each side records only counts, start/minimum/maximum/final grids, duration, and flush reason, keyed by opaque Terminal identity; summaries never include pixels, output, prompts, commands, source, paths, or environment data. Each side also remembers the last grid it sampled across bursts (per Renderer pane instance, per Terminal Host Terminal id) and seeds the next burst's `start` from it without counting that seed toward `sampleCount`, so a settled one-step resize is reported as an actual before-to-after change instead of reading as unchanged; the remembered grid is cleared when its owning pane or Terminal is retired. PTY throughput is aggregated per one-second window into the bounded `pty.throughput` metric; the matching log record stays at `debug` unless bytes were dropped (`warn`). Each PTY lifetime writes at most two `info` records: `pty.first_input` once the first window carrying input closes (with the delay from spawn to the first input write, stamped when the bytes were written rather than at the window boundary), and `pty.throughput_summary` at retirement with lifetime totals, the peak window, the active-window count, duration, and the retire reason. The PTY data callback updates only the in-memory parsed screen and live delivery queue; normal lifecycle finalization crosses the parser barrier and writes one bounded screen BLOB instead of persisting raw output periodically. Bootstrap loads all Session state rows in one query and reuses its already-loaded Terminal records to validate every state's Terminal ownership without per-Session reads. A direct aggregate state read batches ownership into one query, while a targeted state read keeps the same read-time repair with one Session-scoped ownership query. Terminal exit, restart/restore, and Agent metadata events refresh only their identified records through one coalesced small read; application attach, Server Core recovery, and structural mutations retain full bootstrap as the convergence path. Monaco stays out of the terminal-first Renderer bundle; after Server Core attachment, a single shared idle preload primes editor-core plus JavaScript, TypeScript/TSX, JSON, HTML, CSS, Markdown, and dotenv tokenization before the first real file selection. Language workers remain demand-loaded.

`benchmark:startup` exercises a representative large repository and requires Server Core, Terminal, Files, and Git to become usable within three seconds. It also validates timed log coverage, zero request/watcher failures, aggregated terminal metrics, and fewer than 256 Server Core file descriptors. `benchmark:editor` separately launches isolated cold and idle-preloaded renderers. The common-language idle preload must complete within three seconds; the first JavaScript or TypeScript document, editor mount, and visible syntax highlight must complete within 250 ms of selection in both paths, and a repeated open must visibly highlight within the same bound.

`benchmark:renderer` uses React's profiling build to switch once between two of eight seeded Sessions
over a populated, expanded file tree. Its strict receipt retains per-surface render counts and bounded
duration summaries for the Primary Sidebar, Workbench, and Secondary Sidebar, plus fixed
`session.select` and `app.bootstrap` request summaries. CI hard-gates one request of each kind,
per-surface render counts and total React duration, focus/visibility integrity, and truncation;
any frame interval at or above 100 ms also fails as a visible freeze, while refresh-rate-sensitive
percentiles, missed-frame estimates, Long Animation Frame, and Event Timing values remain diagnostic.
Component-level fiber trees stay outside the build and durable receipt because subtree-inclusive timings
cannot supply an additive component budget.

## Diagnostics and privacy

Structured logs carry timestamp, process, level, event, correlation ID, duration, and the build's application version and commit when known. Diagnostics contain application/runtime versions, redacted metadata/state, counts, and timing summaries. Home paths normalize to `$HOME`; secret-like keys, bearer/API tokens, GitHub tokens, and Slack tokens are redacted. Bundles never include file contents, terminal output/snapshots, environment values, prompts/responses, or agent transcripts.

Structured event names are owned by the browser-safe protocol `logEventCatalog`; production log sinks accept only its derived `LogEventName`, and the `logs.query.event` filter uses the same schema. Query results deliberately keep a bounded string event so older or externally produced JSONL records remain readable without weakening production write-time typing.

Diagnostics are held to two standards at once: a record must explain a specific failure after it happened, and the record set must measure behavior well enough to surface a problem nobody reported yet. Three call-site defects break the second standard while appearing to satisfy the first. An event that names an outcome but not its cause — a signal "ignored", a request "skipped" — reads identically to a lost event, so any such outcome carries a closed reason enum rather than a bare boolean. A high-frequency event that is deduplicated or sampled to bound log volume can no longer answer "how many", so it is paired with one aggregate record per owning lifetime (launch, session, connection) carrying counts by outcome, counts by fixed enum member, and the slowest observed handling. State that only reaches the Renderer as an event leaves no local timeline, so a health or authority transition is logged with its `from` and `to` values whenever it changes. Aggregates use flat, fixed-vocabulary field names derived from the closed enum they count, because log records cannot nest and a bounded field space keeps a summary analyzable with `jq` alone. Metrics stay coarse under the fixed `owner`/`phase`/`outcome` labels of ADR 0008; the per-event detail belongs in the log record, never in a dynamic metric label.

Routine success on a hot path is logged at `debug`, not `info`. Production log sinks run at `info`, retain three 5MB generations per process, and are shared by every subsystem, so one chatty successful operation silently evicts the low-volume lifecycle evidence that incidents actually need. Failure paths keep their full `info`/`warn` records and timings.

GPU failures form one Main-owned correlated incident. Main decodes Electron's raw POSIX child status into the Chromium result code, records selected window state and GPU command-line switches, then captures bounded hardware, ANGLE, Skia/Graphite, and feature status after `gpu-info-update`. The workbench Renderer may report only a strict browser-safe diagnostic union: Terminal renderer status with opaque Terminal identity, renderer enums and counters, process/focus/visibility booleans; the session GPU incident budget transition with its closed cause and counts; the content-free resize burst summary defined above; the fixed-schema Renderer performance receipt; or an OSC 52 clipboard write failure reduced to a closed error category, permission-query outcome, secure-context state, focus/visibility state, and user-activation booleans. These branches never admit Terminal output, clipboard content or size, prompts, DOM text, error names or messages, stack traces, source, paths, or environment data. Renderer reports immediately before or after a GPU exit are linked through the incident correlation window so post-mortem triage can distinguish a native GPU process loss from a stale xterm atlas or an input-focus failure. An incident may fall affected Terminals back to DOM rendering for the current session, but it never changes the next-launch hardware-acceleration setting; entering GPU Safe Mode requires an explicit user action.

An enabled Terminal that falls back to DOM may retry WebGL at most three times within a rolling 60-second window, with jittered exponential backoff (1 s base, doubling, ±50% jitter, 60 s cap) so panes that lost the same GPU process do not rebuild their contexts in the same instant. Retries wait until the mounted pane and document are visible, stop permanently for that mount after the budget is exhausted, and are cancelled by disposal or a renderer-preference change. Because every pane is rebuilt on each tab switch, a per-mount budget alone cannot converge: a Renderer-session GPU incident budget counts distinct Main-correlated `gpu.recoveryRequested` incidents and, after three, pins every current and later-mounted Terminal to DOM with the closed reason `context-loss-limit`; the trigger is `gpu-incident-limit` when the pin ends an in-flight retry sequence (including one already exhausted on an already-DOM pane), and `preference-change`, `webgl-context-loss`, or `gpu-process-recovery` when a pane resolves under an already-pinned budget. The `on` preference pins only on Main-observed incidents; `auto` additionally pins after three context-loss episodes (losses within 2 s count as one episode, since one GPU event drops every pane's context), which covers contexts Chromium evicts without a GPU process exit. Every controller must be constructed with the session policy; there is no default that never pins. A pinned pane still publishes `visibility-restore` (with the closed reason) so Main can count restores after the pin, and an `unsupported` pane re-probes WebGL2 on visibility restore, activating with `webgl-reprobe-succeeded` once the GPU process is back. The budget caches only a positive WebGL2 probe per incident so a negative observed during the GPU restart gap is re-probed, is never persisted across launches, and resets only when the applied GPU acceleration preference actually changes; each pin and reset is reported once as a session-level `gpu-incident-budget` diagnostic (transition, closed cause, counts, Main correlation) that Main logs as `gpu.session_budget`. Terminal visibility restores are frame-scheduled: the focus, visibilitychange, and pageshow events of one window restore merge into one restore per pane, panes of a split run on consecutive frames in mount order, and the Renderer-lifetime count of merged events travels with every Terminal renderer diagnostic. Each retry sequence carries one content-free UUID plus its state, attempt count, limit, and next delay through the strict Renderer diagnostic union. A Main-owned GPU incident correlation remains attached across the delayed sequence, allowing diagnostics to distinguish scheduled, deferred, attempted, succeeded, failed, exhausted, cancelled, and budget-limited recovery without admitting arbitrary messages or user content. The `gpu.process_gone` record always carries the correlation-window counts (diagnostics, Terminals, WebGL creations, visibility restores) plus `relatedRendererSaturation`, which reads `buffer-limit` when the 32-entry Renderer diagnostic ring buffer evicted a diagnostic that would still fall inside the window, so the counts are lower bounds rather than exact.

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

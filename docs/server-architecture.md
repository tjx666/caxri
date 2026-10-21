---
kind: living
status: current
---

# Server architecture

- Date: 2026-08-25
- Scope: current repository, artifact, process, dependency, security, and observability boundaries;
  sections explicitly labeled future describe post-cutover product work

## Outcome

Caxri has one independently deployable Server and replaceable Desktop and CLI Clients. The same Server
artifact runs when supervised by Desktop, CLI, an operator, or a platform. The current product uses an
authenticated private loopback transport; direct and Relay access are future product capabilities.
Local-first security, Terminal fidelity, bounded recovery, and content-free diagnostics are product
invariants rather than Desktop-only implementation details.

The irreversible choices are recorded in:

- [ADR 0004: Independently deployable Server](./adr/0004-independently-deployable-server.md)
- [ADR 0005: Multi-Client state ownership](./adr/0005-multi-client-state-ownership.md)
- [ADR 0006: Durable changefeed and streaming protocol](./adr/0006-durable-changefeed-and-streaming-protocol.md)
- [ADR 0007: Remote access and Project authorization](./adr/0007-remote-access-and-project-authorization.md)
- [ADR 0008: Agent-native observability](./adr/0008-agent-native-observability.md)
- [ADR 0010: Server Core idle-exit policy](./adr/0010-server-core-idle-exit.md)

### Frozen compatibility identifiers

Architecture ownership uses Server, Server Core, Terminal Host, Extension Host, Desktop, and Client.
The pre-refactor public protocol and CLI already exposed identifiers such as `host.status`, `host.stop`,
`host.read`, `hostId`, and `CAXRI_AGENT_ENDPOINT_HOST_ID`, together with established error text. The
cutover keeps those observable contracts byte-for-byte stable to preserve A0 behavior. They are
compatibility identifiers, not current owner terminology; renaming them requires a separate product and
protocol change with its own Acceptance evidence.

## Repository topology

Only independently runnable or deployable product entrypoints belong in `apps/`. Importable contracts
and reusable implementation belong in `packages/`. Empty future applications are not created.

```text
apps/
  desktop/
  server/
  cli/

packages/
  agent-skills/
  client/
  protocol/
  extension-api/
  system/
  utils/

extensions/
e2e/
scripts/
docs/
```

The repository root is a private workspace orchestrator and owns no product `src/` tree. Web, Mobile,
and Relay enter `apps/` only when they become real deliverables. A platform fleet, account service, or
billing control plane is a separate product rather than another module inside `apps/server`.

## Deployment model

One Server serves one isolated execution environment. A platform achieves multi-tenancy by scheduling
isolated Server instances, never by adding tenant identity to every Server domain object.

Supervision and access are independent dimensions:

| Supervision mode   | Owner                                                    |
| ------------------ | -------------------------------------------------------- |
| `desktop-managed`  | Desktop starts and monitors the packaged Server artifact |
| `self-managed`     | CLI or an operator starts and monitors the Server        |
| `platform-managed` | An external fleet manager starts an isolated Server      |

| Access mode | Path                                                             |
| ----------- | ---------------------------------------------------------------- |
| `local`     | Private loopback endpoint and local bootstrap credential         |
| `direct`    | TLS endpoint authenticated by pairing, grants, and short tickets |
| `relay`     | End-to-end encrypted traffic through a blind Relay               |

There is no separate Local Server or Remote Server implementation.

### Artifact contract

`apps/server` produces one self-contained directory artifact:

```text
server/
  runtime/
  bundles/
  native/
  extensions/
  metadata/
```

This is the current emitted layout. Database migrations are compiled into the Server Core bundle, so
the artifact carries no separate migrations directory. It may consume workspace packages while building, but running the
artifact never requires installing another Caxri workspace. Desktop embeds this directory unchanged,
CLI supervises the same layout, and a platform image copies the same layout. A smoke test copies the
artifact outside the monorepo, starts it with an isolated data directory, verifies readiness and a
protocol handshake, and shuts it down cleanly.

The Server archive and platform image are independent release artifacts. Desktop embeds the matching
archive. A self-managed distribution may co-install CLI and Server artifacts, while
`@caxri/client/supervise` receives an explicit artifact descriptor and never downloads an executable or
imports Server source. The standalone Server remains directly runnable without CLI.

## Server process ownership

For Desktop Main, recovery timers, restart budgets, and other exact implementation-contract detail
this section does not restate, see
[Process ownership](../.agents/skills/project-architecture/references/process-model.md).

```text
Clients
  │
  ├── control WebSocket ──────────────┐
  ├── Terminal attachment WebSocket ─┼── Server Core
  └── file transfer WebSocket ────────┘      │
                                              ├── SQLite and changefeed
                                              ├── Terminal Host
                                              └── Extension Host
```

### Server Core

The Server Core owns access, authentication, connections, public command dispatch, subscriptions,
Projects, Sessions, files, Git, settings, Agent orchestration, authoritative state, the changefeed, and
durable command receipts. It dispatches domain work directly without a second generic process hop.

[Visible Agent delegation](agent-delegation.md) adds private task/result ownership and exact native
turn evidence above process dispatch. Server Core owns continuation admission, human-input fences,
and explicit resume on a frozen provider conversation. Terminal Host receives the structured launch
or exact-generation input operation. Session selection restores only the outer Shell
while a delegated task is still active, and resumes the Agent's conversation once every task
settled, without resubmitting any task.

An explicit Desktop quit already stops an idle Server Core directly (see
[Process ownership](../.agents/skills/project-architecture/references/process-model.md)), but a force-killed, crashed,
or mid-restart Desktop never runs that path. Server Core additionally self-terminates through its normal shutdown path
once the aggregate authenticated connection count across every transport has stayed at zero for a fixed idle
threshold, deferring while any Terminal PTY is active, the same signal the interactive `host.stop` command requires
explicit confirmation to override, so a Server whose Sessions still own live PTYs never idle-exits on its own.
[ADR 0010](./adr/0010-server-core-idle-exit.md) records the policy, including why counting connections directly
already covers a Desktop lease expiring, with no separate lease check, and why the threshold is an internal seam,
never a user setting.

### Terminal Host

The Terminal Host owns PTY masters, Shell and Agent processes, bounded output buffers, screen state,
process-tree metadata, and Terminal attachment fencing. The Server Core is its only supervisor and
starts it as a private child with a versioned authenticated protocol. The child publishes a private
owner manifest for diagnostics, but the current lifecycle deliberately remains coupled: a Server Core
generation never adopts PTYs from another Terminal Host or Server Core generation. A Terminal Host loss
invalidates its live PTYs, and a Server Core shutdown terminates its Terminal Host after bounded snapshot
capture. Compatible discovery, adoption, and live Terminal continuity are future P1/P5 capabilities.
Per-Terminal PTY generations are fenced on both sides: Terminal Host keeps a baseline only for IDs
Server Core can relaunch, fences permanently closed IDs after `terminal.retire`, and seals a
generation the moment its `terminal.stop` is admitted, as specified in
[terminal-lifecycle.md](../.agents/skills/project-architecture/references/terminal-lifecycle.md).

### Extension Host

One shared Extension Host owns trusted Extension objects, activation, Extension providers such as
`TreeDataProvider`, and generation-scoped public API instances. It owns no database, Project, Session,
PTY, Desktop bridge, or React component. This is fault isolation, not a sandbox for malicious code.
Agent provider adapters remain privileged Server internals and are not ordinary Extensions.

The Extension Host starts only when it is needed: when a Desktop attaches or a request first needs
an Extension (`apps/server/src/core/extensions/host-start-gate.ts`). A Server that only a CLI,
Mobile, or Agent Endpoint talks to, or an SSH Host Server between Desktop sessions, never forks it
(about 33 MB of resident memory). `extension_host.ready` records the closed start trigger.

### Memory footprint

Server bundles are emitted as ASCII-only JavaScript (`codegen.asciiOnly` plus a build guard in
`apps/server/vite.config.ts`). V8 stores a script containing any non-ASCII character as two-byte
source, so one stray `…` doubled the bundle's in-memory size; the guard fails the build instead of
letting that regress silently. Rarely used dependencies (theme plist/YAML parsing, the diagnostics
archiver) are loaded on first use. Together these cut Server Core's idle footprint on macOS from
about 88 MB to 66 MB and its JavaScript from about 7.0 MB to 4.8 MB.

The protocol definitions the Terminal Host and Extension Host use live in leaf modules, so they do
not pull schema-heavy protocol modules into those hosts, and the Server build fails when either
host's startup JavaScript exceeds its budget.
Server Core runs with a capped V8 young generation (`SERVER_CORE_EXEC_ARGV`). The measured SSH Host
requirements, the footprint baseline, and its benchmark are in
[server-footprint.md](server-footprint.md).

## Client architecture

`packages/client` is the only shared public Client implementation. Its root is a narrow browser-safe
facade rather than a broad barrel, with explicit subpath exports for cohesive capabilities:

```text
@caxri/client
@caxri/client/connection
@caxri/client/state
@caxri/client/supervise
```

`connection` owns handshake, retry, recovery, subscription catch-up, and connection health. `state`
owns Client-side projections and Session Views. `supervise` is the platform-specific Server artifact
discovery and lifecycle surface used by Desktop and CLI; it is unavailable to Web and Mobile and never
imports `apps/server` source. UI components cannot create transports, retry loops, or raw RPC clients.

## Future Multi-Client state ownership

This section records the accepted P2 ownership target. The current cutover preserves the existing
single Desktop lease, Session-wide Workbench state, Renderer-local dirty buffers, and current Attention
semantics. Those product behaviors do not change as part of A0–A7.

Server domain state and Client presentation state are deliberately separate:

| Owner        | State                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| Server       | Project, Session, active Workbench Root, Terminal, Draft, Agent Run, Activity, Attention |
| Session View | pane layout, open resources, active pane, view state, optional Workbench Root override   |
| Connection   | subscriptions, attachment identity, flow control, transient focus                        |
| Window       | Open Session, viewed Session, focus and visibility (see ADR 0017)                        |

A Session View is persisted by the Server under `(Client ID, Session)`, but only that Client writes it.
It does not participate in shared domain revision conflicts. A View may override the active Workbench
Root for that Client; without an override it follows the shared Session value, including Agent-driven
worktree changes. File and Git commands carry the active authorized Project ID, never a root path.
Terminal records are shared, while each Session View places them independently.

Draft bodies are durable Server state keyed by Session, Workbench Root, and path. They carry revisions,
record their base disk identity, and remain distinct from clean disk content. Edits require the expected
Draft revision; save requires both the Draft revision and base disk identity. A watcher-detected external
change emits content-free `draft.diskChanged` metadata, and a mismatched base returns a structured
conflict for diff, reload, or explicit resolution rather than silently replacing either side. Caxri does
not provide simultaneous collaborative editing, a Draft writer lease, CRDT, or operational
transformation.

Draft bodies never enter changefeed payloads, command receipts, logs, metrics, diagnostics, crash
capsules, or remote observability export. Metadata is bounded to identity, revision, byte count, and
content-free lifecycle state. Per-Draft and aggregate byte budgets apply. Save or explicit discard
removes the body; Session deletion, Project deletion or deauthorization, Workbench Root removal, and
Server reset apply deterministic bounded cleanup without deleting user files.

Attention acknowledgement is shared: once any Client visibly acknowledges an Attention generation, all
Clients clear that generation. A Client may still have local notification presentation state, but not a
different domain-level unread answer.

There is no global Desktop lease. Terminal input and resize use a Terminal Control Lease. Entity writes
use revisions and preconditions. A command requiring native UI selects a currently connected Client
that explicitly advertised the required capability.

## Current state delivery and command recovery

State tables are authoritative. The current Server writes structural changes to a bounded durable
changefeed and uses request identity to deduplicate in-flight and completed requests. Five reviewed
synchronous SQLite structural commands (`project.reorder`, `project.setIcon`,
`project.setChatDefault`, `session.markRead`, and `session.unarchive`) commit state, content-free events, and their receipt in one transaction. Commands
`session.rename` first completes its idempotent Agent-provider operation, then commits the returned
title, content-free event, and durable receipt in one SQLite transaction. Other commands that cross
filesystem, PTY, Git, Agent-provider, or Desktop boundaries retain their A0 behavior and persist a
content-free receipt after the owning effect returns; they do not claim transactional exactly-once
behavior across the external effect. The fully durable Multi-Client idempotency model for those owners
remains part of P2. In that target, the Server writes or coordinates:

1. the new state;
2. a content-free changefeed entry;
3. a durable receipt for an effectful command when applicable.

Every effectful command is explicitly classified as no recovery, boot-memory recovery, transactionally
durable, or dependent on an owning external-effect idempotency protocol. Repeating a completed durable
command ID returns its receipt. Only the reviewed structural class currently guarantees that losing the
original reply cannot expose an execute-before-receipt crash window.

A changefeed cursor is `(serverId, stateEpoch, sequence)`. Subscription startup performs bounded
snapshot or catch-up delivery and crosses an explicit live barrier before receiving new entries. Wrong
Server identity, an incompatible State Epoch, or an expired cursor falls back to a bounded snapshot.

Terminal bytes, source contents, prompts, and transcripts never enter the changefeed. Terminal display
recovers from bounded screen snapshots. Agent Run and Attention lifecycle metadata may be durable when
it contains no user content.

### `session.updateState` revisions

One `session_state` row per Session is written by more than one writer today: every Renderer that has
the Session open, plus the Server itself when a Terminal appears in or leaves every Root, or when a
deauthorized Project is pruned out of the stored arrangements. A write carries the whole arrangement,
so without a precondition the last write to arrive silently erased whatever landed between the writer's
read and its write.

Every `SessionState` therefore carries a `revision`: a non-negative integer the Server increments on
each write that actually changes the row. `0` means no stored row exists yet.

- **On a snapshot,** `revision` is the revision now stored.
- **On a `session.updateState` request,** it is the revision the writer read. The Server compares it
  against the stored one and rejects a mismatch with `CONFLICT`, carrying
  `{ currentRevision, writtenRevision }` in `CaxriError.details` so the writer can re-derive its change
  without another read.
- **On the answer to an accepted write,** it is the revision now stored. A client must adopt it before
  writing again, even when the rest of the answer matches what it sent.

The check is whole-write, not per field. The pane layout is a tree: merging two arrangements field by
field would produce a third one neither writer asked for, so the losing writer re-derives its change
against the state that won instead.

A rejected write is the one failure the Renderer must not roll back: the state it would roll back to
is precisely the one that turned out to be stale. `patchSessionState` drops the Session's optimistic
overlay, re-reads the snapshot, and shows no toast, because a lost race is not something the user can
act on and the UI has already converged on what won.

A Renderer never races itself. Two layout changes for one Session both read `revision` from the same
optimistic overlay, because the first write has not answered yet; sent side by side, the second would
be rejected for a conflict this Renderer had with nobody but itself, and the user's newer change would
be dropped. `patchSessionState` therefore queues writes per Session and hands each one the revision its
predecessor stored, so `CONFLICT` keeps its real meaning: another writer moved the row.

Because it is a designed, caller-absorbed outcome rather than a defect, `CONFLICT` is logged at `warn`
at every boundary (`isCallerHandledFailure` in `@caxri/protocol`) instead of `error`. It stays logged
so its real volume remains measurable: ordinary contention must be countable without being mistaken
for a fault.

A rejection alone cannot say what moved the row, so every write that advances the revision names its
writer with a closed reason: `clientWrite` for a `session.updateState` request, `serviceWrite` for a
Server service writing a whole state (Agent delegation, a dispatch rollback), the read repairs
`rootFirstVisit`, `terminalTabRepair`, and `unreadableRepair`, and the Root rewrites `terminalCreated`,
`terminalClosed`, `terminalMovedAway`, and `projectPruned`. Server Core remembers the last writer of
each Session in memory for its lifetime and logs every Server-owned advance as
`db.session_state_revision_advanced`; client writes are only remembered, because there is one per
layout change. A rejected write logs `db.session_state_stale_write` with `currentRevision`,
`writtenRevision`, and the last writer's reason, stored revision, and age, or `unrecorded` when nothing
moved the row during this lifetime. A `lastWriteRevision` that differs from `currentRevision` means
the remembered write was rolled back, or a writer outside this bookkeeping moved the row since.

Do not confuse `revision` with the `state_version` column, which is a storage-schema version used to
decide whether a row can be parsed or must be repaired and is identical for every row under one schema.

## Transport

WebSocket is the current common bidirectional transport. The protocol specifies logical lanes while allowing
their physical mapping to evolve:

- one JSON control WebSocket for handshake, commands, replies, subscriptions, and liveness;
- one binary WebSocket per attached Terminal stream;
- one binary WebSocket per bounded file transfer.

Separate stream connections avoid cross-lane head-of-line blocking and provide natural connection-level
backpressure. Each connection has byte budgets, bounded queues, chunk limits, high-water behavior, and
explicit close reasons. Caxri does not implement a custom priority multiplexer over one WebSocket.

Within one control WebSocket, Server Core admits requests in arrival order
(`apps/server/src/core/control-server-lane.ts`). A read settles independently once admitted. A
repository mutation (an Extension command, a `source.action` view operation, or a core Git write such
as `git.switchBranch` or `git.mergePullRequest`) moves on to the connection's repository lane, where
those mutations run one at a time, because nothing below serializes an Extension `git pull` against a
checkout. Every other write holds the ordered lane until it settles. A seconds-long pull request merge
therefore no longer delays a later `session.select`. The `ipc.request` log records `queueMs` and
`queueDepth` for every request and `lane: 'repository'` for the repository lane, so a write that
still holds the ordered lane shows up as queue time on the requests behind it.

The current Server does not expose public HTTP, readiness, pairing, or remote ticket endpoints. Future
direct access may add only minimal liveness, readiness, pairing, and short-lived WebSocket ticket
endpoints. Business commands will not be mirrored as REST, and SSE will not become a second event
transport.

The initial handshake exposes protocol version, negotiated framing features, authenticated principal,
supported capabilities and commands, plus Client, connection, Server, boot, and State Epoch identity
when durable recovery is negotiated. Build identity is discovered through the private artifact manifest
and the frozen `host.status` compatibility command; it is not part of the welcome envelope.
Compatibility gates individual features rather than relying only on one globally increasing protocol
number.

A Terminal stream ticket is bound to Server, Session, Terminal, PTY generation, attachment, and
operation. The Server Core authenticates public streams and proxies bounded bytes to the private Terminal
Host; direct Client access never expands the Terminal Host trust boundary.

## Current identity and future remote access

The Client never supplies an authoritative principal or capability list. The Server derives both from
the authenticated connection and checks per-method scopes, method capabilities, effect classification,
ownership, input schema, output schema, and command identity.

The current local transport derives authority from the private profile manifest, bootstrap credential,
authenticated connection, and method capability checks. Direct access is future P3 work and will use
TLS with a certificate fingerprint carried by pairing, revocable Client Grants, and
one-use short-lived WebSocket tickets. The same ticket authority authenticates control and attached
binary streams without putting a long-lived credential in a WebSocket URL or subprotocol.

Project authorization always occurs on the Server. A privileged Client may browse the Server filesystem
through a bounded, scope-protected API and authorize the exact canonical folder selected there. A
same-machine Desktop may render a native picker, but the resulting Server path still passes through the
same authorization command. A remote Client path is never interpreted as a Server path.

A future Relay accepts only outbound Server connections, cannot read encrypted traffic, and owns no
Project, Session, Terminal, or Client Grant state.

## Observability and AI debugging

Every request can be followed across Client, Server Core, Terminal Host, Extension Host, and provider
processes using stable correlation fields. High-cardinality identities belong in logs and traces; metric
dimensions stay low-cardinality.

The implemented internal foundation consists of normalized cross-process correlation, fixed-dimension
metric aggregates, private owner manifests, bounded causal capsules, and a read-only parity classifier.
Desktop additionally emits bounded named Renderer performance scenarios through authenticated IPC to
the existing structured logs; the browser keeps raw frame/render samples only for the scenario
lifetime. This changes no public command, event, UI, CLI, HTTP, or recovery behavior. The classifier reports one of
control, Server Core, Terminal Host, Extension Host, persistence, or stream with a stable reason and
remediation category; it never performs the remediation.

Target public machine-readable surfaces are:

- `/healthz` for process liveness;
- `/readyz` for command readiness;
- `caxri doctor --json` for artifact, endpoint, process, build, worker, and persistence health;
- `caxri capabilities --json` for the authenticated command surface;
- a redacted changefeed tail for synchronization diagnosis;
- bounded lifecycle history and crash capsules with stable reason codes and remediation.

The future Doctor reads artifacts and owner-readable process manifests directly and probes private
process boundaries, so it can distinguish a dead control endpoint from a dead Server Core, Terminal Host,
or Extension Host. A6 intentionally provides only the private manifests and parity classifier.

Metrics cover queue wait and execution, event-loop delay, connection buffered bytes and close reasons,
changefeed lag and snapshot fallbacks, worker health and restarts, PTY throughput and drops, database
latency and contention, watcher count, file descriptors, memory, and Server startup phases.

Diagnostics exclude source content, Draft bodies, Terminal output and snapshots, prompts, transcripts,
credentials, environment values, and secret-like settings. Local deployments never enable an exporter.
A platform operator may explicitly configure authenticated, bounded export under the same content
boundary; exporter failure cannot delay or fail Server work.

Current internal bounds are 256 in-memory metric series, 64 persisted series per process manifest, 32
KiB per manifest, and 128 entries per in-memory causal chain. Manifests are private atomic files and
collection is best-effort, non-overlapping, and unable to fail product work.

## Enforced dependency graph

The following current graph means “may import” and is enforced by ESLint:

```text
agent-skills  -> protocol
client        -> protocol, utils
protocol      -> utils
extension-api -> no workspace dependencies
system        -> protocol, utils
server        -> agent-skills, extension-api, protocol, system, utils
desktop       -> client, protocol, system, utils
cli           -> agent-skills, client, protocol, utils
extensions    -> extension-api
```

Packages never import applications. Applications never import another application's source. Server
processes communicate through their composition root and internal protocol rather than deep-importing
another process implementation. `@caxri/client/supervise` is additionally forbidden from browser
Clients. `@caxri/agent-skills` owns provider-neutral installation, filesystem transactions, and health
inspection shared by Server and CLI; its `testing` entry is rejected from production source. Package
exports, TypeScript project boundaries, cycle checks, and negative contract fixtures
backstop ESLint, but ESLint is the contributor-facing source of truth. The public Extension API does not
import protocol registry or transport internals. Repository tooling and E2E fixtures have explicit,
separately linted test-only edges and cannot become production precedents.

## Explicit non-goals

- in-process multi-tenancy;
- a second Remote Server implementation;
- global event sourcing;
- persisted raw PTY bytes, prompts, transcripts, or source contents in diagnostics;
- an untrusted Extension sandbox before an untrusted Extension product exists;
- a REST mirror, SSE event stack, or custom WebSocket multiplexer;
- simultaneous Draft collaboration, a Draft writer lease, CRDT, or operational transformation;
- a storage abstraction designed for a hypothetical database replacement;
- live Terminal descriptor handoff during the first Terminal Host extraction.

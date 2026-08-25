# Target Server architecture

- Status: accepted target (not current implementation)
- Date: 2026-08-25
- Scope: pre-public target architecture; this document does not describe the currently shipped process layout

## Outcome

Caxri has one independently deployable Server and multiple replaceable Clients. The same Server
artifact runs when supervised by Desktop, CLI, an operator, or a platform, and the same public protocol
works over local, direct, or Relay access. Local-first security, Terminal fidelity, bounded recovery,
and content-free diagnostics remain product invariants rather than Desktop-only implementation details.

The irreversible choices are recorded in:

- [ADR 0004: Independently deployable Server](./adr/0004-independently-deployable-server.md)
- [ADR 0005: Multi-Client state ownership](./adr/0005-multi-client-state-ownership.md)
- [ADR 0006: Durable changefeed and streaming protocol](./adr/0006-durable-changefeed-and-streaming-protocol.md)
- [ADR 0007: Remote access and Project authorization](./adr/0007-remote-access-and-project-authorization.md)
- [ADR 0008: Agent-native observability](./adr/0008-agent-native-observability.md)

## Repository topology

Only independently runnable or deployable product entrypoints belong in `apps/`. Importable contracts
and reusable implementation belong in `packages/`. Empty future applications are not created.

```text
apps/
  desktop/
  server/
  cli/

packages/
  client/
  protocol/
  extension-api/
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
  migrations/
  extensions/
  metadata/
```

It may consume workspace packages while building, but running the artifact never requires installing
another Caxri workspace. Desktop embeds this directory unchanged, CLI supervises the same layout, and a
platform image copies the same layout. A smoke test copies the artifact outside the monorepo, starts it
with an isolated data directory, verifies readiness and a protocol handshake, and shuts it down cleanly.

The Server archive and platform image are independent release artifacts. Desktop embeds the matching
archive. A self-managed distribution may co-install CLI and Server artifacts, while
`@caxri/client/supervise` receives an explicit artifact descriptor and never downloads an executable or
imports Server source. The standalone Server remains directly runnable without CLI.

## Server process ownership

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
durable command receipts. It performs no extra generic Host-to-Runtime hop before domain work.

### Terminal Host

The Terminal Host owns PTY masters, Shell and Agent processes, bounded output buffers, screen state,
process-tree metadata, and Terminal attachment fencing. The Server Core is its only supervisor and
starts it detached. It is independently discoverable through an owner-readable manifest containing its
process, endpoint, build, and Server identity, plus a private endpoint credential and versioned internal
handshake.

On startup, a Server Core authenticates and adopts a compatible existing Terminal Host. It terminates
and replaces an incompatible or unverifiable instance and marks affected Terminals dead with a stable
reason. A Server Core restart can therefore preserve Terminals, while a Terminal Host crash may terminate
them. Transferring live descriptors between two Terminal Host versions is not part of the initial
contract; a Server artifact upgrade terminates Terminals until that later capability exists.

### Extension Host

One shared Extension Host owns trusted Extension objects, activation, Extension providers such as
`TreeDataProvider`, and generation-scoped public API instances. It owns no database, Project, Session,
PTY, Desktop bridge, or React component. This is fault isolation, not a sandbox for malicious code.
Agent provider adapters remain privileged Server internals and are not ordinary Extensions.

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

## Multi-Client state ownership

Server domain state and Client presentation state are deliberately separate:

| Owner        | State                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| Server       | Project, Session, active Workbench Root, Terminal, Draft, Agent Run, Activity, Attention |
| Session View | pane layout, open resources, active pane, view state, optional Workbench Root override   |
| Connection   | subscriptions, attachment identity, flow control, transient focus                        |

A Session View is persisted by the Server under `(Client ID, Session)`, but only that Client writes it.
It does not participate in shared domain revision conflicts. A View may override the active Workbench
Root for that Client; without an override it follows the shared Session value, including Agent-driven
worktree changes. File and Git commands carry the selected authorized Project ID, never a root path.
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

## State delivery and command recovery

State tables are authoritative. In the same transaction as each structural mutation, the Server writes:

1. the new state;
2. a content-free changefeed entry;
3. a durable receipt for an effectful command when applicable.

Every effectful command carries a Client-generated command ID. Repeating the ID returns the durable
receipt rather than executing the effect twice, including when the original reply was lost during a
disconnect.

A changefeed cursor is `(serverId, stateEpoch, sequence)`. Subscription startup performs bounded
snapshot or catch-up delivery and crosses an explicit live barrier before receiving new entries. Wrong
Server identity, an incompatible State Epoch, or an expired cursor falls back to a bounded snapshot.

Terminal bytes, source contents, prompts, and transcripts never enter the changefeed. Terminal display
recovers from bounded screen snapshots. Agent Run and Attention lifecycle metadata may be durable when
it contains no user content.

## Public transport

WebSocket is the common bidirectional transport. The protocol specifies logical lanes while allowing
their physical mapping to evolve:

- one JSON control WebSocket for handshake, commands, replies, subscriptions, and liveness;
- one binary WebSocket per attached Terminal stream;
- one binary WebSocket per bounded file transfer.

Separate stream connections avoid cross-lane head-of-line blocking and provide natural connection-level
backpressure. Each connection has byte budgets, bounded queues, chunk limits, high-water behavior, and
explicit close reasons. Caxri does not implement a custom priority multiplexer over one WebSocket.

Minimal HTTP endpoints are limited to liveness, readiness, pairing, and short-lived WebSocket tickets.
Business commands are not mirrored as REST, and SSE is not a second event transport.

The initial handshake exposes build ID, protocol version, Server ID, Server Boot ID, State Epoch,
framing features, principal, scopes, and supported capabilities. Compatibility gates individual
features rather than relying only on one globally increasing protocol number.

A Terminal stream ticket is bound to Server, Session, Terminal, PTY generation, attachment, and
operation. The Server Core authenticates public streams and proxies bounded bytes to the private Terminal
Host; direct Client access never expands the Terminal Host trust boundary.

## Identity and access

The Client never supplies an authoritative principal or capability list. The Server derives both from
the authenticated connection and checks per-method scopes, method capabilities, effect classification,
ownership, input schema, output schema, and command identity.

Direct access uses TLS with a certificate fingerprint carried by pairing, revocable Client Grants, and
one-use short-lived WebSocket tickets. The same ticket authority authenticates control and attached
binary streams without putting a long-lived credential in a WebSocket URL or subprotocol.

Project authorization always occurs on the Server. A privileged Client may browse the Server filesystem
through a bounded, scope-protected API and authorize the exact canonical directory selected there. A
same-machine Desktop may render a native picker, but the resulting Server path still passes through the
same authorization command. A remote Client path is never interpreted as a Server path.

A future Relay accepts only outbound Server connections, cannot read encrypted traffic, and owns no
Project, Session, Terminal, or Client Grant state.

## Observability and AI debugging

Every request can be followed across Client, Server Core, Terminal Host, Extension Host, and provider
processes using stable correlation fields. High-cardinality identities belong in logs and traces; metric
dimensions stay low-cardinality.

Required machine-readable surfaces are:

- `/healthz` for process liveness;
- `/readyz` for command readiness;
- `caxri doctor --json` for artifact, endpoint, process, build, worker, and persistence health;
- `caxri capabilities --json` for the authenticated command surface;
- a redacted changefeed tail for synchronization diagnosis;
- bounded lifecycle history and crash capsules with stable reason codes and remediation.

Doctor reads artifact and owner-readable process manifests directly and probes the Terminal Host private
endpoint, so it can distinguish a dead control endpoint from a dead Server Core or Terminal Host.

Metrics cover queue wait and execution, event-loop delay, connection buffered bytes and close reasons,
changefeed lag and snapshot fallbacks, worker health and restarts, PTY throughput and drops, database
latency and contention, watcher count, file descriptors, memory, and Server startup phases.

Diagnostics exclude source content, Draft bodies, Terminal output and snapshots, prompts, transcripts,
credentials, environment values, and secret-like settings. Local deployments never enable an exporter.
A platform operator may explicitly configure authenticated, bounded export under the same content
boundary; exporter failure cannot delay or fail Server work.

## Enforced dependency graph

The following graph means “may import” and is enforced by ESLint from the first commit that introduces
the target workspaces:

```text
client        -> protocol, utils
server        -> protocol, extension-api, utils
desktop       -> client, protocol, utils
cli           -> client, protocol, utils
extensions    -> extension-api
```

Packages never import applications. Applications never import another application's source. Server
processes communicate through their composition root and internal protocol rather than deep-importing
another process implementation. `@caxri/client/supervise` is additionally forbidden from browser
Clients. Package exports, TypeScript project boundaries, cycle checks, and negative contract fixtures
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

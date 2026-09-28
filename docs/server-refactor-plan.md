---
kind: historical
status: historical
---

# Server architecture refactor plan

The A0–A7 migration this plan describes is implemented; ADR 0004 through ADR 0008 cite it as their
implementation plan, which is why it stays instead of being deleted. [Server architecture](./server-architecture.md)
describes the resulting current architecture; this file is the historical batch-by-batch record.

- Date: 2026-08-25
- Target: [Target Server architecture](./server-architecture.md)
- Acceptance: [Architecture refactor behavior parity](./refactor-behavior-parity.md)

## Hard invariant

The architecture refactor does not change user-observable product behavior. It may replace workspaces,
artifacts, transports, processes, persistence internals, and data framing, but it preserves current UI,
commands, CLI output and exit codes, protocol results and stable errors, persistence projections,
security rejection, Terminal behavior, reconnect semantics, and documented failure outcomes.

Multi-Client behavior, Server-owned Drafts, remote pairing, Relay, new diagnostic commands, and Terminal
survival across a Server Core restart are target capabilities, not hidden refactor scope. They remain
separate product changes after the refactor reaches parity.

This plan is not authorization to implement or mutate remote issues. Every batch removes the pattern it
supersedes, updates current architecture and contributor contracts, and produces an exact-head parity
receipt before the next batch begins.

## Architecture-refactor dependency order

```text
A0 Freeze behavior and install parity gates
  -> A1 Control WebSocket migration (issue caxri#366, current layout)
      -> A2a Workspace contract and import guardrails
          -> A2b Shared package boundaries
              -> A2c Move CLI to apps/cli
                  -> A2d Move Desktop to apps/desktop
                      -> A2e Move Server sources to apps/server
                          -> A2f Standalone Server artifact and root cutover
                              -> A3a Merge generic Host and Runtime into Server Core
                                  -> A3b Extract the Terminal Host boundary with parity lifecycle
                                      -> A4 Durable identity, receipts, and changefeed
                                          -> A5 Binary Terminal and file streams
                                              -> A6 Internal observability and fault diagnostics
                                                  -> A7 Full differential Acceptance and architecture cutover
```

The implementation landed [issue caxri#366](https://github.com/tjx666/caxri/issues/366) before the A2
workspace migration. Its baseline and implementation pointed at the former source layout, and its
UDS-specific connection code was deleted before connection logic moved into `packages/client`. A2 was a
six-batch migration family, making fourteen independently gated architecture batches in total. Every A2
sub-batch landed as its own exact-head review and parity boundary; the source tree was never copied into
parallel old and new implementations for a later bulk cutover.

## A0 — Freeze behavior and install parity gates

### A0 outcome

Prove that the current behavior is known and that the repository can detect semantic drift before any
architecture source moves.

### A0 scope

- read back ADR 0004 through ADR 0008 as accepted target decisions and keep their implementation status
  pending until the owning batch lands;
- freeze the exact baseline commit, tree, build, artifacts, fixtures, environment, scenarios,
  normalization schema, budgets, and initial intentional-difference allowlist;
- inventory public protocol methods, principals, capabilities, success results, stable error families,
  events, CLI commands, persistence projections, visual critical journeys, and recovery paths;
- add missing behavior-level tests against the old implementation at their narrowest owning boundary;
- add focused real-Electron cases only for process wiring, PTY, recovery, packaging, and visible behavior;
- implement the repository parity runner and prove it detects seeded semantic differences;
- archive the already built before artifacts, file hashes, and one fallback execution environment rather
  than relying on a future rebuild;
- record before evidence sequentially in isolated profiles, including inspected Desktop evidence for
  visible critical journeys;
- define future ESLint dependency rules and negative fixtures before target workspaces appear.

### A0 exit receipts

- every planned behavior scenario is `pass`, `fail`, `blocked`, or `invalid`; none is silently omitted;
- the immutable baseline manifest verifies the archived before artifacts and can start them in the
  primary or declared fallback environment;
- comparator mutation tests catch changed errors, event order or payload, CLI exit, Terminal state,
  persistence, and visible UI;
- evidence contains no source, Draft body, Terminal output, transcript, credential, or environment value;
- startup, reconnect, Terminal latency, memory, file descriptor, watcher, database, and queue budgets are
  frozen before implementation.

## A1 — Control WebSocket migration

### A1 outcome

Replace the local UDS control transport with loopback WebSocket while preserving every current product
sequence. This is the complete scope of
[issue caxri#366](https://github.com/tjx666/caxri/issues/366).

### A1 scope

- run issue caxri#366's before sequence against the A0 artifact before changing transport code;
- replace the production UDS listener with one loopback WebSocket control endpoint;
- move endpoint discovery to the existing private profile manifest;
- migrate Desktop, CLI, and Agent Endpoint without extracting a new workspace yet;
- add only the issue's minimal `/healthz` endpoint;
- keep current hello, welcome, command, reply, event, credential, Desktop lease, and recovery semantics;
- delete UDS framing, socket files, path-length logic, inode checks, fallback, and adapters;
- record only endpoint shape, transport receipt, and the loopback content-free `/healthz` surface as
  intentional differences.

Final handshake identity, State Epoch, feature gates, readiness, binary streams, and remote authentication
remain later batches. A1 does not spend reusable infrastructure on the temporary global Desktop lease.

### A1 exit receipts

- the same frozen actions produce equal normalized command, event, CLI, persistence, Terminal, recovery,
  security, performance, and Desktop evidence;
- wrong credentials and profile, timeout, oversized control frames, reconnect, lease replacement, stale
  generation, and Desktop wait behavior remain unchanged;
- the new exact head contains no production UDS listener, socket endpoint, or decoder;
- no visible intentional difference is accepted.

## A2 — Repository topology migration

A2 makes the target `apps/*` and `packages/*` ownership graph real without changing process ownership or
product behavior. It is split by reviewable ownership boundary rather than delivered as one mechanical
mega-move. Each sub-batch moves tests with their owner, updates every path-sensitive build and tooling
consumer in the same change, removes the superseded path, and passes the frozen parity catalog before
the next move starts.

| Current ownership                                                 | Target ownership                                                    | Batch       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | ----------- |
| reusable connection and projection code                           | `packages/client`                                                   | A2b         |
| reusable Agent skill installation and health logic                | `packages/agent-skills`                                             | A2b         |
| `packages/api`                                                    | `packages/extension-api`                                            | A2b         |
| `src/shared`                                                      | owning application or browser-safe package, with no shared catchall | A2b/A2d/A2e |
| `packages/cli`                                                    | `apps/cli`                                                          | A2c         |
| `src/main`, `src/preload`, and `src/renderer`                     | `apps/desktop`                                                      | A2d         |
| `src/host`, `src/runtime`, and `src/extension-host`               | `apps/server`                                                       | A2e         |
| reusable process, filesystem, build, and observability primitives | `packages/system`                                                   | A2e         |
| root product entrypoints and transitional path machinery          | none; root becomes a private workspace orchestrator                 | A2f         |

### A2a — Workspace contract and import guardrails

#### A2a outcome

Make the target dependency direction executable before any target path becomes a precedent.

#### A2a scope

- define `apps/*` as independently runnable or deployable products and `packages/*` as importable
  contracts or reusable implementation without committing empty application workspaces;
- update workspace globs, TypeScript project references, build and test discovery, path-sensitive
  repository scripts, source-layout guidance, and workspace contract tests so they understand both the
  current source locations and the next authorized target location;
- enable ESLint application/package boundaries, explicit package exports, cycle checks, browser-safety
  rules, and negative fixtures before the first source move;
- encode every temporary current-layout allowance explicitly, with the A2 sub-batch that must delete it;
- keep the root package's current product entrypoints until their owning source moves, while preventing
  any new cross-boundary dependency that would make those moves harder.

#### A2a exit receipts

- every forbidden target edge has a failing ESLint or workspace-contract fixture;
- every temporary allowance names its removal batch, and no wildcard application-to-application import
  is allowed;
- the unchanged production sources, build, package, CLI, and Desktop pass their existing gates;
- A0 parity receipts remain equal because this batch changes enforcement only.

### A2b — Shared package boundaries

#### A2b outcome

Establish the reusable package seams that applications consume before application source is relocated.

#### A2b scope

- extract WS-native connection, retry, recovery, projection, and artifact-supervision contracts into
  `packages/client` without carrying deleted UDS code;
- extract provider-neutral Agent skill installation, filesystem transactions, bundle generation, and
  health inspection into `packages/agent-skills`, shared by Server and CLI without introducing an
  application-to-application edge;
- keep the `@caxri/client` root browser-safe and expose environment-specific supervision only through
  its reviewed subpath;
- rename the physical public API workspace to `packages/extension-api` while retaining its reviewed
  public import identity and keeping it independent from protocol registry and transport internals;
- move remaining genuinely shared browser-safe contracts into `packages/protocol`, keep pure utilities
  in `packages/utils`, and leave application-specific shared code with its application owner;
- migrate every consumer in the same change and delete compatibility re-exports once the last consumer
  leaves them.

#### A2b exit receipts

- package-consumer tests prove only declared exports are reachable;
- `packages/agent-skills`, `packages/client`, `packages/protocol`, `packages/extension-api`, and `packages/utils` satisfy their
  browser, runtime-dependency, and ownership constraints;
- no application imports another application's source or a package-private deep path;
- control connection, recovery, CLI, Agent, and Desktop parity receipts remain equal.

### A2c — Move CLI to `apps/cli`

#### A2c outcome

Make CLI an independently runnable application while preserving its commands, output, exit codes, and
standalone distribution.

#### A2c scope

- move `packages/cli` production source, tests, package manifest, build entry, embedded product skill,
  and artifact validation to `apps/cli` with `git mv` semantics;
- keep the CLI composition root and its `commands`, connection, and skills boundaries intact during the
  move;
- consume public package exports only, including `packages/client` for Server connection and
  supervision;
- update repository commands, packaging, docs, test discovery, and all path-derived runtime asset
  resolution, then remove the old CLI workspace and its A2a allowance.

#### A2c exit receipts

- the CLI artifact runs outside the monorepo with its existing human, JSON, and Agent behavior;
- command output, stable errors, exit codes, endpoint selection, skills, and Desktop wait behavior match
  the A0 baseline;
- no `packages/cli` source, build entry, documentation precedent, or transitional import remains.

### A2d — Move Desktop to `apps/desktop`

#### A2d outcome

Make Electron Main, Preload, Renderer, and Process Explorer one Desktop application workspace without
changing their runtime or security behavior.

#### A2d scope

- move Desktop-owned Main, Preload, Renderer, Process Explorer, assets, and their tests beneath
  `apps/desktop` while preserving the internal Renderer feature structure;
- move Desktop-only shared code with the Desktop and replace cross-application shared imports with the
  public package boundaries established in A2b;
- update Electron Vite inputs, TypeScript projects, aliases, Vitest, Playwright, packaging, native asset,
  CDP, build-ID, and development-launch path resolution in the same change;
- preserve sandboxing, preload allowlists, native-dialog boundaries, BrowserWindow ownership, Desktop
  lifecycle, and the current Server supervision contract;
- delete the old Desktop source paths and their A2a allowances after all consumers move.

#### A2d exit receipts

- dev, production, and packaged Desktop launch from the new workspace with the same profile and artifact
  behavior;
- the real Electron critical journeys are semantically and visually equal to the A0 evidence;
- Renderer remains browser-safe, Preload remains narrow, and no application-source import bypasses a
  package boundary;
- startup, editor, Terminal, memory, watcher, and file-descriptor budgets do not regress.

### A2e — Move Server sources to `apps/server`

#### A2e outcome

Give all Server-owned source one application boundary while deliberately preserving its current internal
process and failure topology until A3.

#### A2e scope

- move the current service entrypoint, domain Runtime, Extension Host, persistence, migrations, PTY,
  watcher, Git, Agent, and diagnostic implementation beneath `apps/server` with their owning tests;
- keep the current generic Host, Runtime child, and Extension Host process boundaries behaviorally
  intact during this physical move; their temporary internal names and directories are removed by A3a,
  not disguised as final architecture;
- update process entrypoints, `import.meta.url` assets, native-module loading, migrations, extension
  bundles, worker paths, packaging inputs, development runners, benchmarks, and fault-injection fixtures;
- make Desktop and CLI consume only `packages/client` rather than importing `apps/server` source;
- place reusable non-browser process, filesystem, build, observability, and test-harness primitives in
  `packages/system`, which the standalone Server bundles rather than requiring at runtime;
- remove the root Server source paths and their A2a allowances after all launchers target the new app.

#### A2e exit receipts

- the same process tree, readiness order, restart behavior, persistence, Terminal lifecycle, Extension
  behavior, stable failures, and diagnostics are observed from the new paths;
- production build, native compatibility, migrations, extensions, CLI/Agent connection, benchmarks, and
  real Desktop attach pass;
- no production Server source or deep Server import remains under the root `src/` tree;
- every path-only evidence difference is normalized explicitly, with no product-facing difference.

### A2f — Standalone Server artifact and root cutover

#### A2f outcome

Complete the topology cutover and prove that `apps/server` produces the same independently deployable
artifact for Desktop, self-managed, and future platform supervision.

#### A2f scope

- produce the self-contained Server directory containing runtime code, bundles, native dependencies,
  migrations, extensions, and metadata;
- make Desktop package that exact archive and make CLI or an operator supervise the same layout through
  `packages/client`, without downloading an executable or importing Server source;
- copy the artifact to a temporary directory outside the monorepo and start it with no sibling Caxri
  workspace installed;
- make the repository root a private workspace orchestrator, remove the product `src/` tree, transitional
  aliases, path fallbacks, and every remaining A2a allowance;
- update `AGENTS.md`, source-layout, architecture, CLI, Extension, operator, build, package, and release
  documentation to describe only the new topology.

#### A2f exit receipts

- the copied Server artifact starts outside the monorepo, reports readiness, completes an authenticated
  protocol handshake, and shuts down cleanly without installing another Caxri workspace;
- packaged Desktop and self-managed distribution consume byte-identical Server inputs;
- the root owns no product source, application source never imports another application, and all final
  ESLint boundaries and negative fixtures pass without transitional allowances;
- the complete A0 scenario catalog remains semantically and visually equal across the topology cutover;
- production build, package-consumer smoke, startup budget, CLI, Agent, and real Desktop attach pass.

## A3a — Merge the generic Host and Runtime into Server Core

### A3a outcome

Remove the extra generic dispatch process and establish one Server Core composition root while keeping
PTY ownership and current recovery results unchanged.

### A3a scope

- move authentication, connections, dispatch, domain services, persistence, Extension supervision, and
  current structural event delivery into Server Core;
- move Core restart ownership, capped backoff, and ready-window semantics into the artifact supervision
  contract used by Desktop and CLI; a platform supervisor must provide the same contract;
- keep PTY implementation in Server Core until A3b so one batch changes one failure boundary;
- preserve public command ordering, request cancellation, Desktop targeting, event recovery, Terminal
  death/restart outcomes, and stable errors;
- remove Host-to-Runtime request serialization and every obsolete internal owner term or compatibility
  path; frozen public identifiers such as `host.status` remain unchanged for behavior parity;
- update diagnostics to distinguish the new internal cause without changing product-facing outcomes.

### A3a exit receipts

- ordinary commands cross no generic process hop;
- fault injection at every former Host/Runtime boundary produces the same normalized UI, CLI, Terminal,
  persistence, and stable error outcomes;
- a real Desktop Core-crash scenario reaches the same visible recovery state, data preservation,
  Terminal death report, available actions, and recovery-time budget as the A0 Runtime-crash baseline;
- no old Host/Runtime source, internal protocol owner, launch path, or process-name assumption remains;
  frozen public compatibility identifiers are the only terminology exception;
- queue, startup, memory, database, watcher, and Terminal budgets do not regress.

## A3b — Extract the Terminal Host boundary

### A3b outcome

Move PTY and Agent process ownership behind the final internal protocol without enabling new resilience
behavior during the refactor.

### A3b scope

- extract PTY masters, Shell and Agent processes, screen state, bounded buffers, and attachment fencing
  into Terminal Host;
- authenticate a private Core-to-Terminal protocol and bind every operation to Server, Session, Terminal,
  PTY generation, attachment, and capability;
- keep Terminal Host lifecycle coupled to Server Core for behavior parity in this batch through one
  composition-root policy with JSDoc linking to P1; no domain module may reproduce the parity shim;
- preserve current Terminal death, restart, snapshot, attach, input, resize, and stale-generation results;
- implement version and drift checks needed for the final boundary without adopting orphan processes yet;
- keep Extension Host failure isolation unchanged.

Independent discovery, orphan adoption, survival across Core restart, and upgrade handoff remain later
product resilience work. The target ADR records that destination without turning it into a parity
exception.

### A3b exit receipts

- every Terminal scenario has equal normalized screen, dimensions, process status, exit, snapshot, and
  stable failure evidence;
- wrong credential, Server, Session, Terminal, generation, attachment, and operation fail closed;
- Terminal Host and Extension Host failures cannot corrupt Server state or another process boundary;
- Terminal throughput, echo, resize, memory, and buffered bytes stay within A0 budgets.

## A4 — Durable identity, receipts, and changefeed

### A4 outcome

Replace process-local recovery mechanisms with durable internals while presenting the same one-Desktop
product and event behavior.

### A4 scope

- persist Server ID and add Server Boot ID, Client ID, Connection ID, and State Epoch;
- extend the handshake with identity and feature-gated framing metadata;
- write structural state, content-free changefeed records, and receipts atomically for the reviewed
  synchronous SQLite structural commands;
- replace the current event journal with bounded snapshot or catch-up followed by a live barrier;
- classify every effectful command as unrecoverable, boot-memory recoverable, transactionally durable, or
  dependent on an owning external-effect idempotency protocol;
- return durable receipts for repeated command IDs without changing documented command results, while
  preserving the A0 outcome for filesystem, PTY, Git, and Desktop effects that cannot share a SQLite
  transaction;
- preserve the current global Desktop lease, Session state ownership, dirty-buffer behavior, public event
  kinds, event projection, CLI output, event ordering guarantees, and recovery results; durable Server
  identity and live barriers remain internal to `events.recover`;
- add private parity inspection for changefeed state without adding a new public CLI command.

### A4 exit receipts

- reply-loss fault injection cannot execute a reviewed transactionally durable structural command twice;
- every other effectful command preserves its A0 outcome and is explicitly classified without claiming
  database-transactional exactly-once behavior across an external side effect;
- disconnects at every snapshot, catch-up, and live boundary converge without gaps or duplicate public
  effects;
- wrong epoch and expired cursor take deterministic bounded paths that project the same current state;
- changefeed, receipts, parity evidence, and logs contain no prohibited content;
- retention, database contention, idle connection, queue memory, and recovery budgets pass.

## A5 — Binary Terminal and file streams

### A5 outcome

Replace large JSON data paths with independent bounded binary streams without changing Terminal, file,
or control behavior.

### A5 scope

- keep one JSON control WebSocket and attach independent authenticated Terminal and file WebSockets;
- route public stream authentication through Server Core and bounded bytes through the private Terminal
  Host protocol;
- add chunk limits, byte budgets, high-water behavior, pause and resume, and typed internal close reasons;
- preserve current Terminal text, input, resize, snapshot, file content, command errors, and UI behavior;
- remove Terminal and file bulk payloads from the control path without persisting raw bytes.

### A5 exit receipts

- the A0 Terminal and file scenarios remain semantically and visually equal;
- large file transfer and output cannot regress heartbeat, command, or interactive latency budgets;
- slow and disconnected consumers remain memory bounded and retain current user-visible failure results;
- raw Terminal bytes and file contents do not enter evidence, logs, changefeed, or diagnostics.

## A6 — Internal observability and fault diagnostics

### A6 outcome

Make every new boundary diagnosable by agents without adding or changing a user-facing product surface.

### A6 scope

- propagate stable trace, request, operation, build, Server, boot, connection, process, Session, Terminal,
  and Agent correlation through existing internal logs and parity receipts;
- add low-cardinality internal metrics for queues, connections, changefeed, processes, PTY, persistence,
  watchers, file descriptors, memory, and startup;
- add bounded internal lifecycle and crash capsules with stable reasons and remediation categories;
- make the parity runner diagnose a dead control endpoint, Server Core, Terminal Host, or Extension Host
  from owner-readable manifests and probes;
- keep local export disabled and preserve every diagnostic content exclusion.

Public `doctor`, `capabilities`, changefeed-tail commands, readiness, and platform export remain later
operator capabilities so this batch has no new CLI or HTTP behavior.

### A6 exit receipts

- seeded control, Core, Terminal Host, Extension Host, persistence, and stream failures each produce one
  bounded machine-readable causal chain;
- observability collection cannot block product work or alter command, event, UI, CLI, or recovery results;
- cardinality, retention, CPU, memory, and storage budgets pass with collection enabled;
- privacy contract tests reject source, Draft, Terminal, prompt, transcript, credential, and environment
  content.

## A7 — Full differential Acceptance and architecture cutover

### A7 outcome

Prove the final refactored artifact preserves the frozen product before the architecture ADRs become the
current implementation contract.

### A7 scope

- restore and verify the archived before artifact, build the candidate exact head, and run both in the
  same valid environment; a reconstruction experiment never substitutes for a mismatched archive;
- replay the complete non-visual, fault-injection, performance, packaging, and visible Desktop catalog;
- inspect all real-Electron screenshots and temporal evidence;
- audit the intentional-difference allowlist and remove entries that expired with earlier batches;
- update current architecture, CLI, Extension, operator, source-layout, and contributor documentation;
- verify searches find no obsolete path, obsolete internal Host/Runtime owner term, UDS path, mixed
  Session state owner, or forbidden import precedent; frozen public compatibility identifiers and
  historical baseline language are explicit exceptions;
- mark the behavior-preserving architecture cutover complete only when every required case is green.

### A7 exit receipts

- zero unexplained semantic, visual, persistence, CLI, security, recovery, or packaging differences;
- zero user-visible intentional differences;
- every performance metric remains within its frozen budget;
- standalone Server artifact and packaged Desktop use identical Server inputs;
- focused gates, production build, standalone artifact smoke, exact-head local review, and immutable
  Acceptance evidence are independently green.

## Later product capabilities

The following work depends on the refactor but is not part of its parity claim:

```text
A7 parity cutover
  ├── P1 Terminal continuity and public operator diagnostics
  ├── P2 Concurrent Clients, Session Views, shared Attention, and Server-owned Drafts
  │     └── P3 Direct remote access and Server-side Project authorization
  │           └── P4 Platform operability and optional blind Relay
  └── P5 Live Terminal handoff across Terminal Host upgrades
```

### P1 — Resilience and operator diagnostics

Enable independent Terminal Host discovery and adoption so a Server Core restart preserves Terminals;
add readiness, `doctor --json`, `capabilities --json`, and redacted changefeed inspection. These are
explicitly new recovery and operator behaviors with their own requirements and Acceptance.

### P2 — Concurrent Clients and state ownership

Persist Session Views per `(Client ID, Session)`, remove the global Desktop lease, add Terminal Control
Leases and explicit native-capable Client targeting, make Attention acknowledgement global, and migrate
Renderer-local dirty buffers to revisioned Server-owned Drafts with base-disk conflict detection. This
batch updates the intentional dirty-buffer trade-off rather than disguising it as refactor parity.

### P3 — Direct remote access

Add TLS pairing and pinning, revocable Client Grants, short-lived one-use stream tickets, per-method
scopes, remote endpoint selection, and bounded Server-side Project browsing and authorization. Validate
the same protocol across a real network boundary without Client filesystem assumptions.

### P4 — Platform operability and optional Relay

Add platform images, readiness, drain, migration, rollback, operator-configured bounded export, and fleet
compatibility around the same single-tenant Server artifact. Relay remains a separately authorized blind,
end-to-end encrypted access product and never becomes a Server dependency.

### P5 — Live Terminal handoff

Only after Terminal continuity proves valuable, add descriptor transfer between Terminal Host versions
so a planned Server artifact upgrade can preserve live Terminals. Until then, upgrades explicitly
terminate Terminals with stable product messaging.

## Cross-batch gates

Every architecture batch must include:

- focused behavior-level coverage written before implementation at the changed boundary;
- the frozen differential replay and exact-head comparison receipt;
- ESLint boundary fixtures before a new target path can become precedent;
- standalone artifact or package-consumer smoke tests where relevant;
- privacy-safe structured evidence rather than raw log or content snapshots;
- a performance comparison with a frozen threshold and environment validity check;
- current architecture and operator-document updates;
- no parallel old and new source-of-truth implementation after the batch lands.

The future capability batches become separate issues only after A7. Existing
[issue caxri#366](https://github.com/tjx666/caxri/issues/366) was the independent A1 transport migration
and completed its exact-before/exact-after parity record before A2a started.

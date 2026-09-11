# Typed IPC, capabilities, events, and errors

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

The shared dispatcher validates protocol version, command, parameters, principal, capabilities,
owner availability, and results before it returns `{ protocolVersion, ok, result | error }`. Read
commands may execute again; write and control commands coalesce the same principal/request ID and
reject an ID reused with different command content. The Electron adapter additionally validates the
requesting WebContents before invoking that dispatcher. Internal Server methods remain outside the
public command registry.

Visible task delegation owns a separate `agent-delegation` Server domain. Its explicit
`agents.delegate` capability and `agent:delegate` grant never widen human Terminal steer or general
Agent control. Task identity, frozen launch settings and private answers are persisted before/after
the managed Terminal side effects; only exact coordinator-applied turn evidence can produce a
result. See [visible delegation](../../../../docs/agent-delegation.md) for storage, recovery,
provider limits and the staged replacement scope.

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

# Typed IPC, capabilities, events, and errors

`packages/protocol` is the browser-safe, transport-neutral source of truth for command and event
contracts. A command request uses `{ protocolVersion, id, method, params }`; every method declares
one owner (`server` or `desktop`), effect (`read`, `write`, or `control`), required capabilities,
idempotency policy, Zod parameter/result schemas, and an optional principal projection. The
negotiation welcome identifies the authenticated principal and enumerates granted capabilities and
supported commands, so callers can query support without inferring it from errors. Desktop bridge
imports consume the owning `packages/protocol` public export; no other tree may define a second method
or schema table. Protocol source is grouped behind eight domain barrels:
`agent`, `configuration`, `desktop`, `device-store`, `domain`, `mobile`, `registry`, and `transport`; the
package root is the only public package entrypoint. Do not add or remove one of those domains without
updating this reference and `scripts/__tests__/workspace-contract.test.ts`. `device-store` is the one
client-side persistence engine the phone and the Desktop Renderer share: scope-bound, debounced,
best-effort entries for saved copies and unsent-input backups (see
[docs/client-local-data.md](../../../../docs/client-local-data.md)).

The shared dispatcher validates protocol version, command, parameters, principal, capabilities,
owner availability, and results before it returns `{ protocolVersion, ok, result | error }`. Read
commands may execute again; write and control commands coalesce the same principal/request ID and
reject an ID reused with different command content. The Electron adapter additionally validates the
requesting WebContents before invoking that dispatcher. Internal Server methods remain outside the
public command registry. Desktop Main reaches an internal method only when it is listed in
`desktopServerOperationIds`; `DesktopServerConnection.request` rejects any other internal method
before it reaches the wire, and unit tests inject their own request fakes, so a missing entry only
surfaces as a silently failing feature. `apps/desktop/src/main/__tests__/server-operation-routing.test.ts`
enforces the list for every `request('…')` literal in Main.

Controlled view operations use the public protocol union and exhaustive metadata for provider
routing, cancellation, and request lifetime. Host dispatch must remain exhaustive over that union;
Core capability and request Session-scope authorization remain independent of the shared lifecycle policy.

Visible task delegation owns a separate `agent-delegation` Server domain. Its `agents.delegate`
capability, held by every managed Agent, never widens human Terminal steer or general Agent control.
Server Core defers an Agent's target Project check to that domain, which admits the caller's own
Session and Sessions it created in a visible top-level Project. Task identity, frozen launch settings and private answers are persisted before/after
the managed Terminal side effects. Provider adapters own native launch flags, identity and finality:
Claude matches a proven Stop digest, while Codex binds an authenticated turn to a native final event.
Codex result reads advance a bounded private cursor without rescanning unchanged history.
Grok combines authenticated Stop evidence with durable native finality; its live response boundaries
are not persisted. Native Stop execution counts guard against stale evidence after continued drafts.
Grok's shared `prepareLaunch` renders Server-owned `assignedAgentSessionId` and `initialPrompt`
separately from untrusted launch settings, preserving its identity-override rejection and workspace
sandbox requirement. Public launch requests cannot populate those internal fields.
Preset imports use the owner-only `settings.delegation.write` capability and Server configuration
serialization. They replace only `agents.delegation`, preserve unrelated JSONC, default to dry run,
and return no private instructions. This key remains outside ordinary Agent settings patches.
External callers use the separate `delegation-client` principal: one owner-authorized Project,
dedicated Session and caller provider, with only `agents.delegate`. Server Core owns its bounded
private token-digest registry and refreshes expiry/revocation before dispatch receipt lookup and
again before returning a response, so an admitted wait cannot disclose results after revocation.
Owner CLI bootstrap is separate from Renderer folder grants; domain storage atomically reuses or
creates its Project/Session binding without changing Desktop selection. The CLI never starts a
Server implicitly when an external credential is present, and does not change provider sandboxes.
See [visible delegation](../../../../docs/agent-delegation.md) for storage, recovery,
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

The workbench preload (`apps/desktop/src/preload/index.ts`) exposes these globals and nothing else; a key-set
test (`apps/desktop/src/preload/__tests__/exposed-globals.test.ts`) fails when the list drifts, so update it here
in the same change:

- `caxri` (`CaxriBridge`, `packages/protocol/src/transport/transport.ts`): `negotiate` (protocol version handshake),
  `request` and `requestWithId` (the fixed method union; the latter takes a caller-owned request ID so the Renderer can
  cancel a long Core read without passing an `AbortSignal` across the bridge), `onEvent` (journal-backed event stream),
  `reportError` (content-free classifier), `reportDiagnostic` (strict content-free Renderer lifecycle snapshot), and
  `pathForFile` (`webUtils.getPathForFile` for a `File` the user dropped; reads no file).
- `performanceMonitorHost`: `isActive`, `onControl`, and `publish` let the Workbench publish its own frame pacing to a
  detached Performance Monitor window through Main. Main drops a publish that does not come from the monitored window,
  so a companion Renderer sharing this preload gains nothing.
- `__caxriWorktree`: a local path string, present only when `switch-worktree dev` sets `CAXRI_WORKTREE_PATH`, so a CDP
  connection can verify which worktree's window it reached.
- `caxriE2E`: request gates, call counters, the one-shot mobile pairing link bridge, and the poll-interval override,
  present only when `CAXRI_E2E=1` at runtime (see Accepted test seams in `security.md`).

The Process Explorer preload (`processExplorer`) has the same error classifier
beside its snapshot, theme, and language methods and one narrow action, `stopTerminal(terminalId)`.
`stopTerminal` has a dedicated channel; Main checks the sender and the identifier, then calls
`terminal.suspend` for that one Terminal. It is not a request bridge and does not terminate arbitrary
processes. The Performance Monitor preload (`performanceMonitor`) offers state, metrics, reload, overlay and
always-on-top controls, theme, language, snapshot and state subscriptions, and the classifier; Main checks the
sender on each channel. Renderer entries report only `page-exception` or
`unhandled-rejection`; exception values never cross the bridge. Main validates both the sender and
kind, then writes stable structured events. The Agent Commander and Benchmark windows reuse the workbench preload;
Main identifies it as the companion sender and applies `AgentCommanderRendererPolicy` before dispatch
(see `docs/agent-commander.md`). The preload does not expose `ipcRenderer`, Electron
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

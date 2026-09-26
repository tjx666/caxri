# Mobile authorization

Server Core is the authority for paired devices. The gateway authenticates the device credential and
stored generation, then obtains a principal containing its role and granted Project IDs. Every
encrypted request checks that principal against the current registry record before dispatch. The
dispatcher also grants only the capabilities for that role.

## Current method grants

| Role      | Additional methods beyond the preceding role                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`    | `mobile.dashboard`, `mobile.session.show`, `mobile.timeline.read`, `mobile.changes.list`, `mobile.changes.diff`, `mobile.agent.availability`, `terminal.preview`, `mobile.panels.list`, `mobile.tree.children`, `mobile.files.list`, `mobile.files.read` |
| `reply`   | `session.markRead`, `mobile.agent.submit`                                                                                                                                                                                                                |
| `control` | `agent.control.interrupt`, `mobile.session.create`, `mobile.terminal.takeOver`, `mobile.terminal.release`, `mobile.terminal.input`, `mobile.project.browse`, `mobile.project.add`                                                                        |

The method set is explicit. A role grant alone never authorizes a resource: dashboard, Session, and
Terminal reads use principal-scoped queries; an Agent submission also checks the current Primary
Agent endpoint and reserves a durable receipt keyed by device ID, device generation, and
`clientMutationId` before dispatching Terminal input. A request fingerprint rejects reuse of that
identity for different input. Mobile
Session creation checks both the device's Project grant and the current Project record before its
durable write. Git mutations, files, and unrestricted `session.create` are outside the gateway
method set.

The four read-only panel methods (`mobile.panels.list`, `mobile.tree.children`, `mobile.files.list`,
`mobile.files.read`) are granted starting at `view`, since they only project state a device with
access to the Session can already see on the dashboard. Each request re-validates the Session
against the principal's granted Project IDs; `mobile.tree.children` additionally requires the
Session to match Desktop's own `app.activeContext`, because the underlying Extension Host tree is
scoped to whichever Session Desktop currently has focused, not to the requesting device. None of the
four can execute a command or otherwise mutate state. The dispatcher capabilities per role
(`apps/server/src/core/mobile/gateway/role-capabilities.ts`) must cover every allowed method's
required capabilities; a unit test enforces that invariant.

`mobile.project.add` grants the new Project to the requesting device. A live connection adopts a
longer Project list without reconnecting; removing a Project, changing the role, or changing the
device identity still ends the connection.

New pairings receive `control` for the selected Projects. A pre-role device registry opens with no
active grants; its old credentials cannot authenticate. The old store remains untouched until an
explicit new pairing replaces it. Revocation rotates the credential and generation, sends a sealed
revocation notice to authenticated connections, and closes them. An old generation cannot resume or
submit another request.

The dashboard returns the current paired device role so the mobile UI can gate Terminal controls.
Desktop queries return a null role. Server authorization remains authoritative: the three
`mobile.terminal.*` methods require `control`, the exact active connection and Terminal subscription,
the subscription's Terminal generation, and a fresh principal-scoped Terminal query. A `reply` device
may submit an Agent instruction through `mobile.agent.submit` but cannot take over size or send raw
Terminal keys. Git reads use only `mobile.changes.list` and `mobile.changes.diff`; see
[Mobile Changes](CHANGES.md). No Git mutation method is granted.
Size leases use the exact connection and subscription as holder; closing that holder cannot release
a newer connection's lease. Terminal observation requires only `view` and never changes Desktop
attachment or size.

## Mobile Session creation

`mobile.session.create` accepts a granted Project ID and an Agent choice. The access controller
injects the current principal into the internal domain operation; a client cannot provide it. The
domain uses the same Server launch path as Desktop and preserves Desktop's selected Session.

The public result contains only `sessionId`, optional `terminalId`, and an optional bounded
`TERMINAL_START_FAILED` message. A Terminal launch failure after the Session is committed returns
that partial-success result, so the client can open the created Session. Full Session and Terminal
records, local paths, and Agent identities are not returned by this method.

Revocation can finish while Session creation or a short reply is waiting on domain work. The
access controller holds its authority queue only for admission and final authorization checks;
revocation aborts in-flight creates and short replies. The domain checks cancellation immediately before the durable
Session write. If revocation happens after that write, the old connection closes and may lose the
result. After re-pairing, the client must refresh `mobile.dashboard` and reconcile existing Sessions
before offering another create attempt. The submission handler checks cancellation and the exact
Agent endpoint again after reserving its receipt. A confirmed Host acceptance marks it `accepted`;
an uncertain result retains the reservation and returns `unknown`, preventing an automatic second
write. A confirmed rejection removes the reservation so the request may be retried safely. These
bounded receipts establish input admission, not proof that the Agent executed the instruction.

Revocation rejects new operations; it cannot undo effects already admitted to another process.
In particular, an Agent interrupt is authorized and synchronously enqueued to Terminal Host before
the Server can process a later revocation. Physical signal delivery may finish afterward; this is
not a new request admitted using a revoked credential.

## Adding a Project from mobile

`mobile.project.browse` and `mobile.project.add` are `control`-only: they can create a durable
Project record and change what the paired device is allowed to see, so they need the same authority
as Session creation. Both resolve the path parameter against the Mac's own home directory rather
than an arbitrary filesystem root: `mobile.project.browse` lists the visible child directories (git
repository and further-children flags included, dotfolders hidden, bounded to 200 entries) starting
from home when no path is given, or from a home-relative or opaque absolute path otherwise.
`mobile.project.add` reuses the same desktop Project-creation domain service, so a folder that is
already a Project is returned as-is instead of duplicated.

Both methods resolve the submitted path with `realpath` before checking containment, so a `..`
segment and a symlink whose target escapes the home directory are rejected the same way; only a
canonical path that still resolves inside home is accepted. Rejection never logs the attempted path.
After `mobile.project.add` succeeds, the access controller grants the new Project ID to the
requesting device in the device registry — an additive, non-generation-bumping write, so the
device's existing credential keeps working and immediately gains access to the new Project on its
next `mobile.dashboard` read.

The implementation lives in [the access controller](../../apps/server/src/core/mobile/access-controller.ts),
[device registry](../../apps/server/src/core/mobile/device-registry.ts),
[Project browse/add handlers](../../apps/server/src/domains/mobile/project-browse.ts), and
[mobile protocol](../../packages/protocol/src/mobile/mobile-contract.ts).

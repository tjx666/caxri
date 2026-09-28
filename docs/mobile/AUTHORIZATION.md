# Mobile authorization

Server Core is the authority for paired devices. The gateway authenticates the device credential and
stored generation, then obtains a principal containing its role and granted Project IDs. Every
encrypted request checks that principal against the current registry record before dispatch. The
dispatcher also grants only the capabilities for that role.

## Current method grants

| Role      | Additional methods beyond the preceding role                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`    | Dashboard, Session, timeline, changes, Terminal preview, Project panel reads, `mobile.agent.actions`, `mobile.files.search`, and `mobile.attention.list` |
| `reply`   | `session.markRead`, `mobile.agent.submit`, and `mobile.image.upload`                                                                                     |
| `control` | Agent interrupt, Session management, Terminal control, Project add, `mobile.files.write`, and `mobile.attention.answer`                                  |

The method set is explicit. A role grant alone never authorizes a resource: dashboard, Session, and
Terminal reads use principal-scoped queries; an Agent submission also checks the current Primary
Agent endpoint and reserves a durable receipt keyed by device ID, device generation, and
`clientMutationId` before dispatching Terminal input. A request fingerprint rejects reuse of that
identity for different input. Mobile
Session creation checks both the device's Project grant and the current Project record before its
durable write. Git mutations and unrestricted `session.create` are outside the gateway
method set.

`mobile.update.check` and `mobile.update.prepare` are granted to every role: they expose only the
update bundle Desktop ships and a short-lived download token for the requesting device; see
[UPDATE.md](UPDATE.md). Update recovery grants the same two things to a paired, unrevoked device
whose transport version no longer matches, after it proves its credential. It is a separate
pre-authentication exchange outside the dispatcher and method set, so it authorizes nothing else.

The read-only panel methods (`mobile.panels.list`, `mobile.tree.children`, `mobile.files.list`,
`mobile.files.read`, and `mobile.files.search`) are granted starting at `view`, since they only project state a device with
access to the Session can already see on the dashboard. Each request re-validates the Session
against the principal's granted Project IDs; `mobile.tree.children` additionally requires the
Session to match Desktop's own `app.activeContext`, because the underlying Extension Host tree is
scoped to whichever Session Desktop currently has focused, not to the requesting device. None of the
reads can execute a command or otherwise mutate state. The dispatcher capabilities per role
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
Desktop queries return a null role. Server authorization remains authoritative: the four
`mobile.terminal.*` control methods (`takeOver`, `release`, `input`, `scroll`) require `control`, the exact active connection and Terminal subscription,
the subscription's Terminal generation, and a fresh principal-scoped Terminal query. A `reply` device
may submit an Agent instruction through `mobile.agent.submit` but cannot take over size or send raw
Terminal keys. `mobile.terminal.scroll` carries only a bounded line count and grid cell; the Terminal
Host encodes the wheel report or cursor keys from its own parsed modes, so it cannot become an
arbitrary-byte input path. Git reads use only `mobile.changes.list` and `mobile.changes.diff`; see
[Mobile Changes](CHANGES.md). No Git mutation method is granted.
Size leases use the exact connection and subscription as holder; closing that holder cannot release
a newer connection's lease. Terminal observation requires only `view` and never changes Desktop
attachment or size.

## Mobile Session management

`mobile.session.rename`, `mobile.session.archive`, and `mobile.session.restore` resolve the Session
through the principal-scoped query first, so a Session outside the device's Project grant reports
`NOT_FOUND`. They then call Desktop's own `session.rename`, `session.archive`, and
`session.unarchive` handlers; restore places the Session at the top of its Project, as Desktop does.
Each returns only `sessionId`, and the dashboard carries the new state. `mobile.session.archived` is
a read that lists archived Sessions of granted Projects, newest first, bounded to 64 items within
one frame.

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

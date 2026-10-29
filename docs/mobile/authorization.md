---
kind: living
status: current
---

# Mobile authorization

Server Core is the authority for paired devices. The gateway authenticates the device credential and
stored generation, then obtains a principal containing its role and granted Project IDs. Every
encrypted request checks that principal against the current registry record before dispatch. The
dispatcher also grants only the capabilities for that role.

## Current method grants

| Role      | Additional methods beyond the preceding role                                                                                                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`    | Dashboard, Session, timeline, changes, Terminal preview, Project panel reads, `mobile.agent.actions`, `mobile.files.search`, `mobile.attention.list`, `mobile.agentChat.read`, `mobile.agentChat.readHistory`, `mobile.agentChat.readImage`, `mobile.agentChat.readTask`, `mobile.pullRequest.read`, and `mobile.agentUsage.read`                                |
| `reply`   | `session.markRead`, `mobile.agent.submit`, `mobile.image.upload`, `mobile.agentChat.send`, `mobile.agentChat.configure`, `mobile.agentChat.retry`, `mobile.agentChat.{removeQueued,sendQueuedNow,resumeQueue}`, `mobile.agentChat.{takeQueued,readQueued,editQueued}`, and `mobile.agentChat.runCommand`                                                         |
| `control` | Agent interrupt, Session management, Terminal control, Project add, `mobile.files.write`, `mobile.attention.answer`, `mobile.agentChat.respond`, `mobile.agentChat.implementPlan`, `mobile.agentChat.interrupt`, `mobile.agentChat.stopTask`, `mobile.botInbox.{list,reply}`, `mobile.host.status`, `mobile.preview.{list,open}`, and `mobile.pullRequest.merge` |

`mobile.agentChat.configure` carries one field-level rule: a `reply` device may switch the model,
effort, and ultracode, but a `permissionMode` or `planMode` change needs `control`, because a
permission level is the standing form of answering approvals (`mobile.agentChat.respond`). The
gateway refuses it from a `reply` device with `FORBIDDEN`.

The method set is explicit. A role grant alone never authorizes a resource: dashboard, Session, and
Terminal reads use principal-scoped queries; an Agent submission also checks the current Primary
Agent endpoint and reserves a durable receipt keyed by device ID, device generation, and
`clientMutationId` before dispatching Terminal input. A request fingerprint rejects reuse of that
identity for different input. Mobile
Session creation checks both the device's Project grant and the current Project record before its
durable write. Local Git mutations and unrestricted `session.create` are outside the gateway
method set; merging a Session's pull request on GitHub is the one remote Git action, described in
[Merging a pull request from mobile](#merging-a-pull-request-from-mobile).

A Project root path never reaches the phone. The gateway reads a Chat Session's root through the
internal `mobile.session.projectRootInternal`, which checks the Session against the device's grant
like any Session read, only to name changed files Project-relative before the projection leaves the
Server.

`mobile.update.check` and `mobile.update.prepare` are granted to every role: they expose only the
update bundle Desktop ships and a short-lived download token for the requesting device; see
[update.md](update.md). Update recovery grants the same two things to a paired, unrevoked device
whose transport version no longer matches, after it proves its credential. It is a separate
pre-authentication exchange outside the dispatcher and method set, so it authorizes nothing else.

The read-only panel methods (`mobile.panels.list`, `mobile.tree.children`, `mobile.files.list`,
`mobile.files.read`, and `mobile.files.search`) are granted starting at `view`, since they only project state a device with
access to the Session can already see on the dashboard. Each request re-validates the Session
against the principal's granted Project IDs; `mobile.tree.children` reads the extension tree in that
Session's own scope, so it works whether or not Desktop has the Session focused
([ADR 0019](../adr/0019-extension-view-request-scope.md)). None of the
reads can execute a command or otherwise mutate state. The dispatcher capabilities per role
(`apps/server/src/core/mobile/gateway/role-capabilities.ts`) must cover every allowed method's
required capabilities; a unit test enforces that invariant.

`mobile.project.add` grants the new Project to the requesting device. A live connection adopts a
longer Project list without reconnecting; removing a Project or changing the device identity
still ends the connection.

New pairings always receive `control` for the selected Projects: the Server hardcodes the role at pairing
(`apps/server/src/core/mobile/device-registry.ts`) and no API changes it afterward. `view` and `reply` are defined
and enforced by the gateway but cannot be assigned yet; see [issue #2334](https://github.com/tjx666/caxri/issues/2334). Paired devices live in the Server
database's `mobile_devices` table (gateway preferences in the `mobileGateway` app-state cell), so
an update that rebuilds the database clears them and phones pair again. Revocation rotates the credential and generation, sends a sealed
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
[Mobile Changes](changes.md). No local Git mutation method is granted.
Size leases use the exact connection and subscription as holder; closing that holder cannot release
a newer connection's lease. Terminal observation requires only `view` and never changes Desktop
attachment or size.

## Mobile Session management

`mobile.session.rename`, `mobile.session.setPinned`, `mobile.session.archive`, and
`mobile.session.restore` resolve the Session through the principal-scoped query first, so a Session
outside the device's Project grant reports `NOT_FOUND`. They then call Desktop's own
`session.rename`, `session.setPinned`, `session.archive`, and `session.unarchive` handlers; restore
places the Session at the top of its Project, as Desktop does, and a pin made on the phone is the
same pin Desktop's Pinned group shows. All four require the control role.
Each returns only `sessionId`, and the dashboard carries the new state. `mobile.session.archived` is
a read that lists archived Sessions of granted Projects, newest first, bounded to 64 items within
one frame.

`mobile.terminal.switchSurface` reopens a granted Agent Terminal on the other surface (PTY or
Chat). It resolves the Terminal through the principal-scoped query first, so a Terminal outside
the grant reports `NOT_FOUND` before anything restarts, then calls Desktop's own
`terminal.switchSurface`, which owns the Chat-capability check and the running-turn guard. It
requires the control role, like Stop, because the switch replaces the Agent's process and may end
its turn. Unlike the other `mobile.terminal.*` methods it needs no subscription. Its result is only
`switched` or `turnRunning`; the dashboard carries the new surface.

## Merging a pull request from mobile

`mobile.pullRequest.read` returns the pull request of a Session's delivering repository (the primary
repository's when it has one) from the same `projectStatus.summary` the Desktop Status panel shows:
number, title, URL, lifecycle, check state with the first failed check names, head SHA, and a
`mergeBlocker` (conflicts, failed or running checks, branch protection, a stale base, or unknown
mergeability) derived by `pullRequestMergeBlocker` in `@caxri/protocol`, the rule Desktop's Merge
button also follows.

`mobile.pullRequest.merge` requires the control role, because a merge publishes the Session's work
and Caxri cannot undo it. It re-reads the summary, refuses a pull request that is no longer the
Session's (`NOT_FOUND`) or has conflicts (`CONFLICT`), then calls Desktop's own
`git.mergePullRequest` with the head SHA the phone showed. That handler picks the repository's merge
method and passes `--match-head-commit`, so GitHub refuses the merge if new commits landed after the
phone read the pull request. Any blocker other than conflicts still allows a merge; the phone
first asks for a second confirmation that names it, as Desktop does.

## Agent usage from mobile

`mobile.agentUsage.read` answers the phone's Agent usage screen, reached from the gauge button in
the Session list header. Every paired role may read it, because it shows account-wide figures and
public status pages, not Session content. For Claude Code and Codex (plus any other provider that
has reported a plan limit) it returns:

- the latest plan-limit reading (`usage.limits`): each window's used percentage and reset time,
  which the phone shows as what is left, a countdown, and the reset's clock time. Codex records it in
  its transcripts; Claude Code reports it only from a running Chat, so the read first asks the
  provider's newest Agent for its usage, which triggers that Chat's refresh for the next poll;
- the output speed of the provider's most recently active Agent in a Session the device may see
  (archived Sessions are skipped), as the recent-responses aggregate Desktop's tok/s chip shows,
  with the Session title it came from;
- the provider's public status page, read on the Server through the same reader as Desktop's Agent
  status tab, without the uptime history and with at most four incidents.

Each part fails on its own: a failed read leaves only that field absent.

## Mobile Session creation

`mobile.session.create` accepts a granted Project ID, an Agent choice, and an optional `surface`;
`chat` starts a Chat-capable Agent as an Agent Chat and is refused with `VALIDATION` for any other
Agent before a Session is written. The access controller
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
requesting device in the device registry, an additive, non-generation-bumping write, so the
device's existing credential keeps working and immediately gains access to the new Project on its
next `mobile.dashboard` read.

The implementation lives in [the access controller](../../apps/server/src/core/mobile/access-controller.ts),
[Project requests](../../apps/server/src/core/mobile/project-requests.ts),
[device registry](../../apps/server/src/core/mobile/device-registry.ts),
[Project browse/add handlers](../../apps/server/src/domains/mobile/project-browse.ts), and
[mobile protocol](../../packages/protocol/src/mobile/mobile-contract.ts).

## Bot Inbox from mobile

`mobile.botInbox.list` and `mobile.botInbox.reply` are `control`-only. The
[Bot Inbox](../caxri-bot.md#bot-inbox) belongs to the owner rather than to one
Project, so it would show a narrower `view` or `reply` grant items from Projects it cannot see; the
`control` role already reaches beyond its grant through `mobile.project.browse`. The list returns
only open items projected to one gateway frame (questions first, bodies and replies shortened, no
merge-only fields). A reply runs in the authority queue like an attention answer and is stored with
source `mobile` through the internal `mobile.botInbox.replyInternal`, whose handler rechecks
the `control` role. Merge and Dismiss have no mobile method. See
[the Inbox requests](../../apps/server/src/core/mobile/bot-inbox-requests.ts) and
[the mobile Inbox contract](../../packages/protocol/src/mobile/mobile-bot-inbox-contract.ts).

## Computer status from mobile

`mobile.host.status` is `control`-only for the same reason as the Inbox: its Session load list spans
every Project on the computer, not only the device's grant. It reads only; there is no mobile method
to stop a Terminal or process. See [Mobile computer status](host-status.md).

## Page preview from mobile

`mobile.preview.list` and `mobile.preview.open` are `control`-only: the preview proxy forwards every
HTTP method to a local web server, so it can change that server's state like a browser on the
computer. Every proxied request re-checks the device's generation and role. See
[Mobile page preview](preview.md).

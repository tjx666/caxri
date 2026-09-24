# Mobile authorization

Server Core is the authority for paired devices. The gateway authenticates the device credential and
stored generation, then obtains a principal containing its role and granted Project IDs. Every
encrypted request checks that principal against the current registry record before dispatch. The
dispatcher also grants only the capabilities for that role.

## Current method grants

| Role      | Allowed methods                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `view`    | `mobile.dashboard`, `terminal.preview`                                                               |
| `reply`   | `mobile.dashboard`, `terminal.preview`, `session.markRead`, `terminal.send`                          |
| `control` | `mobile.dashboard`, `terminal.preview`, `session.markRead`, `terminal.send`, `mobile.session.create` |

The method set is explicit. A role grant alone never authorizes a resource: dashboard, Session, and
Terminal reads use principal-scoped queries; a short reply also checks the current Primary Agent
Terminal and atomically consumes the requested `attentionEpoch` in the domain handler. Mobile
Session creation checks both the device's Project grant and the current Project record before its
durable write. Git, files, and unrestricted `session.create` are outside the gateway method set.

New pairings receive `control` for the selected Projects. A pre-role device registry opens with no
active grants; its old credentials cannot authenticate. The old store remains untouched until an
explicit new pairing replaces it. Revocation rotates the credential and generation, sends a sealed
revocation notice to authenticated connections, and closes them. An old generation cannot resume or
submit another request.

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
before offering another create attempt. The domain handler checks the cancellation signal, then
checks and consumes short-reply `attentionEpoch` immediately before writing to the Terminal, even
if the access controller's earlier read has become stale.

The implementation lives in [the access controller](../../apps/server/src/core/mobile/access-controller.ts),
[device registry](../../apps/server/src/core/mobile/device-registry.ts), and
[mobile protocol](../../packages/protocol/src/mobile/mobile-contract.ts).

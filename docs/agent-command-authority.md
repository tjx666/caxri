---
kind: living
status: current
---

# Agent command authority

Caxri exposes separate local command domains. Sharing a PTY implementation does
not make their authority, origin, retry, or audit semantics interchangeable.

| Domain                 | CLI                                                                           | Required authority                                                                                               | Content boundary                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Peer Message           | `agent message send\|wait\|reply`                                             | Managed Agent Endpoint with `agents.message`                                                                     | Bounded peer-origin text stays in Server Core memory and never becomes PTY input.                                     |
| Visible Delegation     | `agent delegate create\|status\|wait\|result\|stop`                           | Explicit generation-scoped `agent:delegate` grant, or authenticated owner                                        | Private task/result storage, exact turn evidence, and a same-Session visible child Terminal.                          |
| Agent Dispatch/Control | `agent dispatch start\|resume\|status\|wait`, `agent control interrupt\|stop` | Same-Project reads use `agents.read`; mutations require a project-scoped `agent:control` grant                   | Server Core owns durable receipts, exact provider bindings, and Endpoint generations; Terminal Host owns PTY signals. |
| Human Terminal Steer   | `terminal send --terminal <id> --text <text> [--enter]`                       | Authenticated Desktop or human CLI owner with `terminals.steer`; paired devices have a separate short-reply path | Bounded simulated user input; never a Peer Message and never available to an Agent credential.                        |

## Dispatch lifecycle

`agent delegate import --from <file> [--dry-run|--apply]` requires the owner-only
`settings.delegation.write` capability, not `agent:delegate`. The CLI rejects detected Agent and CI
environments for this command and `terminal send`. These checks distinguish authenticated connection
roles; they do not isolate mutually untrusted processes sharing the same OS user.

`agent delegate access create|list|revoke` requires the owner CLI's `agents.delegation.access`
capability. It issues a separate `delegation-client` principal, bound to one Project, dedicated
Session and caller provider, with only `agents.delegate`. It is not a managed Endpoint and cannot
use messaging, dispatch control, settings import or Terminal steering. Expiry and revocation are
checked before each command, including cached replies. See the
[external caller workflow](agent-delegation.md#external-callers-and-directory-authorization).

For task submission and final answers, use [visible delegation](agent-delegation.md). Dispatch
receipts describe process lifecycle and cannot prove that a particular task has finished.

- `start` creates one fresh Agent Terminal and provider conversation in an exact Project Session.
- `resume` requires the Terminal ID and its currently bound provider session ID. Matching a provider
  name is never sufficient.
- The command request ID is a principal-scoped idempotency key that maps to a separate opaque
  `dispatchId`. Caxri stores the receipt and Terminal identity atomically before spawning, so retrying
  the same request cannot create a second PTY or conversation.
- Receipts expose requested/effective launch fingerprints and argument counts, not provider arguments
  or session secrets. `status` and `wait` are Project-scoped; `wait` observes typed lifecycle revisions
  and supports bounded timeout and disconnect cancellation.
- `interrupt` and `stop` resolve the exact live Agent Endpoint generation, then Server Core and
  Terminal Host recheck the PTY generation and PID. A stale ref fails closed and never falls back to a name or process
  search.

An Agent Endpoint begins with message plus same-Project read capabilities. A Desktop owner may grant
`agent:control` to that exact generation for a bounded TTL; the grant adds dispatch and control only
inside the Endpoint's Project. Retirement, expiry, or a newer generation removes the grant.

## Explicit wake

Ordinary delivery to a stopped Endpoint reports `UNAVAILABLE`. `agent message send --wake` is the only
promotion path and requires both `agents.dispatch` and `agents.control`. Server Core resolves a bounded
tombstone for the exact stopped generation, creates or reuses the durable wake dispatch, verifies the
new Endpoint generation, and only then admits one message. Reusing the request ID cannot spawn or send
twice; a failed dispatch never queues the message.

## Terminal steer and audit

`terminal send` accepts at most 8 KiB of UTF-8 text. It rejects C0 and C1 control characters except
Tab; Enter is represented only by `--enter`. Human CLI mutations require an explicit profile selector
and confirmation (`--yes` for non-interactive use). A paired device may send only a bounded plain-text
reply to the selected waiting Agent after its pairing generation, Project scope, and attention epoch are
rechecked. Server Core logs record only the Terminal ID, byte count, Enter flag, and principal kind.
Text, Peer Message bodies, Terminal output, provider arguments, credentials, and
provider session IDs are excluded from logs and dispatch receipts.

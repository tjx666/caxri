# Execution State Machine

Use these phases as durable checkpoints. Update the run ledger after each
transition rather than reconstructing progress from the conversation.

| Phase                | Entry condition             | Exit condition                                    | Allowed return                     |
| -------------------- | --------------------------- | ------------------------------------------------- | ---------------------------------- |
| `intake`             | `$go` explicitly invoked    | Requirements classified                           | none                               |
| `planning`           | Material decisions resolved | Issues and Acceptance matrix frozen; Goal created | `intake` only before Goal creation |
| `issue_execution`    | Goal or ledger active       | Every queued issue has a reviewed commit          | same phase for repair              |
| `deep_review`        | Issue queue complete        | Cross-issue review clear                          | `issue_execution`                  |
| `delivery`           | Review-clean branch         | PR checks and review clear                        | `deep_review`                      |
| `acceptance`         | Deliverable head stable     | Passing round published                           | `issue_execution` or `deep_review` |
| `waiting_acceptance` | Passing round published     | Human accepts or rejects                          | `acceptance`                       |
| `merge`              | Human accepted current head | PR merged and issues verified                     | `deep_review` if code changes      |
| `self_improvement`   | Delivery merged             | Findings classified                               | none                               |
| `reporting`          | Remote state refreshed      | Final report delivered                            | none                               |
| `complete`           | No required work remains    | Terminal                                          | none                               |

## Per-issue loop

```text
queued → progressing → implement → focused validation → light review
       ↖                 repair valid findings                  ↙
                    commit → complete
```

Create a behavior-level failing regression first when the bug is cheaply
reproducible. Keep commits cohesive and independently explainable. A shared root
cause may satisfy multiple issues, but the ledger and Acceptance matrix must
retain each issue's observable outcome.

## Aggregate loop

```text
all issue commits → full deep review → repair → affected validation → commit
                         ↑                                  |
                         └──────── repeat when needed ──────┘
```

After a clear review, push and create the PR. CI, conflicts, and review findings
route through the same repair discipline. If a delivery repair crosses issue or
architecture boundaries, return to full deep review before Acceptance.

## Discovery routing

| Discovery                                                | Route                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| In-scope regression or missing requirement               | Reopen the owning issue in the ledger and repair now                                       |
| New defect that blocks the frozen business goal          | Create a blocking issue and insert it into the queue                                       |
| Unrelated pre-existing defect                            | Create or update a follow-up issue; do not expand this Goal                                |
| Verification infrastructure defect                       | Repair the Acceptance adapter, fixture, capture, or report tooling                         |
| Hosted CI cannot start because of payment/spending limit | Keep it externally blocked; automatically use the guarded exact-head fallback inside `$go` |
| Other zero-step hosted infrastructure failure            | Keep it externally blocked; request separate user authorization before fallback            |
| Durable product technical debt                           | Record it and create a follow-up issue before completion                                   |
| Narrow project workflow defect                           | Fix directly in the reviewed branch when it will not invalidate accepted evidence          |
| Generic workflow improvement                             | Record an upstream proposal; do not silently fork global behavior                          |

## Guarded local CI fallback

Inside `$go`, a verified GitHub Actions payment or spending-limit failure is
already authorized for local substitution. Do not stop to ask again. Admit a
fallback only when all of these facts are verified for the current PR head:

- the hosted job failed before runner allocation with zero executed steps;
- the cause is external billing or infrastructure, not repository code or tests;
- automatic billing authorization records the original GitHub payment,
  billing, or spending-limit failure text, not a paraphrase;
- project policy authorizes the verified payment/spending-limit failure, or the
  user explicitly authorized another infrastructure failure;
- the ledger records the exact head, workflow URL, job, failure detail, and
  policy or user authorization before local parity starts.

After admission, run the exact platform-neutral commands declared by
`.github/workflows/ci.yml`, in order, followed by one `bun run test:e2e` run on
the same clean head. Record commands and results in the ledger. Both surfaces
must pass before entering Acceptance. Keep the PR status `checks_blocked`; the
local result is substitute evidence, not a green hosted check. A changed head,
missing required authorization, local failure, release package, or deployment
is outside the exception and returns to the normal remote-CI path. Never
re-admit a failed fallback for the same head; repair and push a new head first.

## Waiting without token churn

- Prefer event-driven waits or the runtime's monitoring mechanism.
- On an automatic continuation, query each pending remote system once.
- After publishing an Acceptance URL, yield the turn to the user. Do not keep a
  long-lived shell poller, issue repeated wait calls in the same turn, or send
  periodic commentary that merely restates `pending`.
- If state is unchanged on a later continuation, update only the checkpoint
  timestamp and yield again.
- Do not reread source, rerun tests, regenerate reports, or restate the entire
  plan while CI or human Acceptance is pending.
- Never mark the Goal complete or blocked only because an external review is
  pending.

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

| Discovery                                          | Route                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| In-scope regression or missing requirement         | Reopen the owning issue in the ledger and repair now                                |
| New defect that blocks the frozen business goal    | Create a blocking issue and insert it into the queue                                |
| Unrelated pre-existing defect                      | Create or update a follow-up issue; do not expand this Goal                         |
| Verification infrastructure defect                 | Repair the Acceptance adapter, fixture, capture, or report tooling                  |
| Hosted CI cannot start and has zero executed steps | Record external limitation, run local parity once, and do not mislabel code failure |
| Durable product technical debt                     | Record it and create a follow-up issue before completion                            |
| Narrow project workflow defect                     | Fix directly in the reviewed branch when it will not invalidate accepted evidence   |
| Generic workflow improvement                       | Record an upstream proposal; do not silently fork global behavior                   |

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

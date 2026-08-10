# Execution State Machine

Use these phases as durable checkpoints. Update the run ledger after each
transition rather than reconstructing progress from the conversation.

| Phase                | Entry condition             | Exit condition                                    | Allowed return                     |
| -------------------- | --------------------------- | ------------------------------------------------- | ---------------------------------- |
| `intake`             | `$go` explicitly invoked    | Requirements classified                           | none                               |
| `planning`           | Material decisions resolved | Issues and Acceptance matrix frozen; Goal created | `intake` only before Goal creation |
| `issue_execution`    | Goal or ledger active       | Every queued issue has a reviewed commit          | same phase for repair              |
| `deep_review`        | Issue queue complete        | Exact head review-clean and frozen                | `issue_execution`                  |
| `delivery`           | Frozen review-clean branch  | PR checks and review clear                        | `deep_review`                      |
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

## Aggregate review budget

```text
code-changing gates → full deep review → consolidate → repair P0/P1 → targeted validation
                              │                                      │
                              └──── freeze when current head is clear ┘
```

Complete `knip`, `doctor`, affected builds, and focused Electron E2E before the
first full review so late gates do not reopen a declared-clean head. Wait for all
reports in a round, adjudicate them against the frozen Goal and threat model, and
then repair one cohesive batch.

- Run no more than three full Goal-range rounds. Stop sooner whenever the current
  head has no product P0/P1.
- After round three, allow one targeted verification of its P0/P1 repairs. If it
  exposes another architecture-level P0/P1, request a material architecture or
  scope decision; never start round four.
- P2/P3, stale evidence, PR copy, and workflow bookkeeping do not keep product
  review open. Record debt or fix delivery metadata in its owning phase.
- A report against an old head is advisory. It can reopen work only when its
  product P0/P1 reproduces against the current head.
- Workflow, verification-infrastructure, evidence, and PR-metadata-only commits
  use a `verification` decision after focused validation. It requires a prior
  full product-review baseline, zero product P0/P1, and exact-head freeze. Batch
  them; the ledger permits at most three per Go run.

Record every full, targeted, or verification decision through `state.ts review`. Use
`--freeze` only with zero product P0/P1; the ledger invalidates the freeze when
the PR head changes. CI, Acceptance, and merge cannot reuse the old head's
decision.

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
- the exact PR head is explicitly frozen after the final review decision.

Do not admit fallback while review or code-changing validation is still active.
After admission, run the exact platform-neutral commands declared by
`.github/workflows/ci.yml`, in order, followed by one `bun run test:e2e` run on
the same clean head. Record commands and results in the ledger. Both surfaces
must pass before entering Acceptance. Keep the PR status `checks_blocked`; the
local result is substitute evidence, not a green hosted check. A changed head,
missing required authorization, local failure, release package, or deployment
is outside the exception and returns to the normal remote-CI path. Never
re-admit a failed fallback for the same head; repair and push a new head first.
Normally a Go run gets one full Electron E2E. A product failure or human
Acceptance rejection may invalidate that head and permit one final rerun after
focused repair and a new review freeze. The ledger rejects a third full run.

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

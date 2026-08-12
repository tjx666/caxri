# Intake and Goal Admission

Complete this phase before activating the Goal. The active Goal should not contain
predictable approval pauses.

## Refresh first

Inspect the current branch and worktree, repository remotes, open issues, related
pull requests, and available authentication. Separate live facts from user prose
or stale local memory. Preserve unrelated changes.

Start with the bounded repository snapshot instead of printing complete issue or
Project bodies into context:

```bash
bun run .agents/skills/go/scripts/intake-snapshot.ts --repo tjx666/caxri --project 2
```

Repeat `--issue <number>` to refresh a previously frozen open or closed set. The
snapshot returns compact Git, issue, PR, and Project metadata plus intake-matrix
placeholders. Read the body only for issues admitted to the Goal; never replace
source inspection or requirement classification with the generated placeholders.

After classification, start the admitted Goal with `scripts/start.ts`. It
fetches and pins the latest `origin/main`, creates the dedicated adjacent
worktree/branch, and verifies that the main checkout branch, HEAD, and working
tree did not change. Record the base SHA, branch, main checkout, and worktree in
the ledger; resume only there. Never append a narrow requirement to an existing
broad branch or PR and then validate only the narrow requirement.

For each apparent issue, search open and closed issue titles and bodies, related
PRs, and current source behavior. Record the reused owner or one sentence of
evidence for why the work is new; title similarity alone is not enough.

Check only prerequisites relevant to the planned workflow:

- GitHub authentication and repository identity;
- LobeHub Acceptance authentication;
- dependencies needed by selected issues;
- availability of the macOS Electron acceptance path.

Resolve safe agent-owned mechanics without asking the user. Do not start the
desktop app merely to approve the plan.

## Research before proposing solutions

Invoke the `competitors` skill after requirements are normalized and before an
issue solution or Acceptance matrix is frozen. Inspect current source or dated
research notes for products that already solve the same problem; do not rely on
screenshots, product memory, or an issue author's proposed implementation alone.

- For performance, security, filesystem, editor, IPC, and desktop-platform
  mechanics, use the current official VS Code source as the primary baseline.
- For UI and UX behavior, compare Orca, Muxy, Kero, or the closest products in
  the competitor landscape. Prefer at least two relevant implementations when
  the interaction is not already constrained by the user.
- Record the observed behavior or architecture, the source revision or research
  date, and the Caxri-specific adaptation or deliberate deviation.
- Check licenses before reading implementation details. Reference behavior and
  architecture only when a license does not permit reuse.

Competitor behavior is evidence, not an automatic requirement. Preserve Caxri's
product model, process boundaries, and security grants, and surface a material
trade-off before encoding a stricter or more complex design than the reference.
If no relevant implementation is available, record that briefly and continue.

## Classify every requirement

| Class             | Meaning                                                                   | Action                                                       |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Execute now       | In scope, authorized, and contributes to the business goal                | Add to the current issue queue                               |
| Already satisfied | Current source and behavior already meet it                               | Record evidence; do not create duplicate work                |
| Defer             | Valuable but not required for this Goal                                   | Reuse or create a backlog issue; exclude from the queue      |
| Reject            | Contradictory, unsafe, obsolete, or outside the project boundary          | Record the concise reason; do not create an issue by default |
| Discuss first     | A decision materially changes product behavior, scope, authority, or risk | Resolve before starting the Goal                             |

Do not infer that every sentence is a separate issue. Merge requirements that
share one root cause or atomic delivery, while preserving issue-specific
Acceptance checks and UX outcomes.

## Discuss only material boundaries

Resolve these before the Goal:

- mutually exclusive product behavior;
- an expansion beyond Caxri's agreed product boundary;
- destructive or difficult-to-recover actions;
- secrets, external accounts, paid resources, releases, or production changes;
- missing authority not granted by `$go` and project instructions;
- a user-owned prerequisite that no local inspection can resolve.

A destructive action or release mentioned inside the same `$go` request still
needs an exact target and its own explicit authorization. Keep release execution
outside the product-delivery queue and invoke the project `release` skill only
after that boundary is resolved.

For an ambiguous visual or asset request, resolve its exact macOS Electron
location, dimensions or platform variants, reference or intended difference,
and observable before/after criterion. Do not turn "improve the icon" into an
implementation issue without a verifiable target.

Do not ask about implementation details the agent can determine from the source,
tests, architecture, or reversible experiments.

If a genuinely new material choice emerges during execution, first determine
whether it is required by the frozen business goal. Automatically fix in-scope
regressions, defer unrelated discoveries, and request user input only when no
safe interpretation can satisfy the approved goal.

## Build the issue queue

For each selected issue, record:

- GitHub issue number and title;
- user-visible outcome and non-goals;
- an explicit UX design covering the user path, visible states, copy, keyboard,
  and accessibility behavior, or a reason no direct UI claim exists;
- macOS Electron location or an explicit reason the requirement is not a product
  surface claim;
- dependencies and priority;
- likely owning layer;
- competitor evidence and any deliberate Caxri deviation;
- the authority and threat-model boundary, accepted reference-product residual
  risks, and any explicitly stronger guarantee;
- focused validation;
- stable Acceptance check ids, the issue-authored Acceptance outline, and
  required evidence constraints;
- whether the check is visual, temporal, or non-visual.

Reuse live issues when their current scope matches. Invoke `file-issue` for new
issues so repository issue conventions are preserved. Update a reused issue
before admission when either its `UX 设计` or `Acceptance 方案` is missing or no
longer matches the selected scope. Do not file a speculative issue before
resolving a material decision. New issue titles and human-facing content use
Simplified Chinese while technical identifiers remain English.

Freeze the issue-level Acceptance contract here: what must be demonstrated,
where it is observable, stable ids, and evidence constraints. Do not freeze the
final step-by-step case plan during intake. After the PR head is stable, a fresh
tester subagent derives that plan independently from the delivered behavior.

## Present one plan

Output one compact plan containing:

1. selected issues in execution order;
2. excluded, deferred, and already-satisfied requirements;
3. dependencies and risk hotspots;
4. focused validation and the issue-level Acceptance coverage contract;
5. remote mutations authorized by the explicit `$go` invocation;
6. the exact delivery base and confirmation that the branch/PR scope matches the
   issue-level Acceptance coverage contract;
7. any remaining external blocker.
8. the frozen aggregate review policy, normally `full-once`.

Once material boundaries are settled, create the durable ledger, call
`create_goal` when available, and begin. In a compatible client without that
tool, use the active ledger as the equivalent durable marker. Do not ask for a
second routine confirmation inside Acceptance.

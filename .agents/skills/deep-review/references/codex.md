# Deep Review in Codex

Run this workflow only for explicit deep mode. Review stays read-only throughout.

## Runtime contract

Use the collaboration tools exposed in the session. Spawn every reviewer and verifier with
`fork_turns: "none"` so they receive only the self-contained task prompt. Do not override the model
unless the user or runtime instructions require it. With Caxri's normal four-slot limit, the root
agent has three active subagent slots.

If spawning or context isolation is unavailable, stop and offer light mode. Completion releases an
active slot in Codex; no explicit close operation is required.

## Review groups

Prune dimensions first, then remove empty groups:

| Group         | Dimensions                                               |
| ------------- | -------------------------------------------------------- |
| `correctness` | correctness, state-lifecycle                             |
| `boundaries`  | architecture, security-privacy                           |
| `experience`  | performance-observability, ux-accessibility              |
| `delivery`    | compatibility-release, maintainability-testing, workflow |

Start `correctness`, `boundaries`, and `experience` first. Queue `delivery`, then verification work
as slots become free. Do not drop a group to fit the concurrency limit.

## Step 0: Scope

Follow [scoping.md](scoping.md). Capture `{changes}`, `{scope_summary}`, `{review_head}`, and
`{pr_state}`.

## Step 1: Select rules

Apply `SKILL.md` pruning. For every surviving group, list the exact dimension file paths. Reviewers
must read those files in full and then read only the routed project skills/references relevant to
the changed surface.

## Step 2: Build reviewer prompts

Instantiate [review-prompt.md](review-prompt.md) with the group's dimensions, dimension files,
scope summary, review head, and changes. Each prompt must be self-contained.

## Step 3: Run the queue

Maintain:

- pending reviewer, reviewer-retry, verifier, verifier-retry, and consolidation work;
- active agents;
- confirmed findings, unverified workflow facts, release checks, missing sources, and
  need-more-context entries;
- candidate/confirmed/false-positive counts by dimension.

When a reviewer completes:

1. Validate its payload with:

   ```bash
   bun run .agents/skills/deep-review/scripts/validate-output.ts review
   ```

   Pass the response on stdin or via a task-scoped temporary file.

2. Retry invalid output once with the validation error. If the retry also fails, record missing
   coverage for that group instead of interpreting malformed prose.
3. Append `missing_sources`. Accept `release_checks` only from a reviewer assigned
   `compatibility-release`; retry any other group that emits them.
4. Send `dimension: "workflow"` issues directly to the objective workflow-facts pool.
5. If verifiable issues remain, queue one independent verifier using
   [verify-prompt.md](verify-prompt.md). Never send an issue back to its reviewer.

When a verifier completes:

1. Validate with `validate-output.ts verify`.
2. Require each input id exactly once and reject invented ids.
3. Retry invalid or incomplete ids once with the exact validation problem.
4. Apply valid severity, likelihood, nature, exposure, and fix-option overrides.
5. Add confirmed items to the report pool, count false positives, and retain
   `need_more_context` separately.
6. Enforce invariants after overrides: P0 blocks release; P2 does not; low-likelihood findings block
   only for catastrophic, irreversible impact.

Keep filling every free slot until reviewer and verifier queues are empty.

## Step 4: Consolidate roots

When two or more findings are confirmed, spawn a fresh agent with
[consolidate-prompt.md](consolidate-prompt.md). Validate with `validate-output.ts consolidate`.
Reject invented ids, self-maps, cycles, and mappings to a later finding. One concrete fix must
resolve every issue mapped to the same root.

## Step 5: Refresh external state

In PR mode, refresh checks, mergeability, review decision, unresolved threads, and head SHA. If the
head changed, follow the stale-review rule in `scoping.md`. External state belongs in readiness, not
in code-finding counts.

## Step 6: Render

Use [report-template.md](report-template.md). The report must:

- lead with the conclusion and direct merge recommendation in PR mode;
- separate code correctness, CI/authorization, conflicts, review threads, and operational release
  readiness;
- include only independently confirmed findings plus objective workflow facts;
- keep release checks and missing context separate from defects;
- state exact commands/evidence already run without claiming unrun gates passed.

Do not fix findings or mutate GitHub state. End by letting the user choose any follow-up action.

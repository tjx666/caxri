# Durable Run State

New runs start through the isolated-worktree entry point:

```bash
bun run .agents/skills/go/scripts/start.ts \
  --objective "<business goal>" --branch "chore/<goal-slug>"
```

Keep the returned worktree and `.records/go/<run-id>/state.json` paths. Resume
only in that worktree. For an already-active legacy run, bind its existing
isolated worktree once:

```bash
bun run .agents/skills/go/scripts/state.ts worktree \
  --state "$STATE" --worktree-path "$PWD" \
  --main-checkout-path "/path/to/main-checkout" --base-sha "$BASE_SHA" \
  --branch "chore/<goal-slug>"
```

## Core commands

```bash
bun run .agents/skills/go/scripts/state.ts phase \
  --state "$STATE" --phase issue_execution --reason "Goal created"

bun run .agents/skills/go/scripts/state.ts issue \
  --state "$STATE" --number 42 --title "修复 Terminal 内边距" \
  --status progressing --priority P0 --check issue-42-terminal-inset

# Record a non-material assessment without creating a GitHub comment.
bun run .agents/skills/go/scripts/state.ts drift-assess \
  --state "$STATE" --number 42 --head-sha abc1234 \
  --kind internal_detail --drift-key final-assessment

# Material drift requires the complete four-part Chinese decision record.
bun run .agents/skills/go/scripts/state.ts drift-assess \
  --state "$STATE" --number 42 --head-sha abc1234 \
  --kind acceptance_change --drift-key terminal-evidence \
  --expectation "原计划使用截图证明 Terminal 恢复。" \
  --evidence "真实运行表明该行为只能由时序视频证明。" \
  --decision "保持产品范围，改用视频证据。" \
  --acceptance-impact "稳定检查 issue-42-terminal-inset 改用视频。"

bun run .agents/skills/go/scripts/state.ts drift-comment \
  --state "$STATE" --number 42 --record-id terminal-evidence-r1

bun run .agents/skills/go/scripts/state.ts issue \
  --state "$STATE" --number 42 --status complete \
  --commit abc1234 --validation "focused test passed"

bun run .agents/skills/go/scripts/state.ts pr \
  --state "$STATE" --number 123 --url "https://github.com/..." \
  --status open --head-sha abc1234
```

Freeze the review policy before the aggregate baseline. The default is
`full-once`; use an override only for an explicit pre-review decision.

```bash
bun run .agents/skills/go/scripts/state.ts review-policy \
  --state "$STATE" --mode full-once --source "Go default"

bun run .agents/skills/go/scripts/state.ts review \
  --state "$STATE" --head-sha abc1234 --mode full --p0 0 --p1 0 \
  --scope "Goal-range product review" \
  --reviewed-range "origin/main...abc1234" --freeze

bun run .agents/skills/go/scripts/state.ts review \
  --state "$STATE" --head-sha def5678 --mode light --p0 0 --p1 0 \
  --scope "P1 repair delta" --baseline-review-id review-001 \
  --baseline-head-sha abc1234 --parent-review-id review-001 \
  --reviewed-range "abc1234..def5678" --freeze
```

Record validation independently from review. `log-path` stays below
`validation/` or `ci-artifacts/`.

```bash
bun run .agents/skills/go/scripts/state.ts validation-start \
  --state "$STATE" --kind gates --lineage-id typecheck-repair \
  --head-sha def5678 --command "bun run typecheck" \
  --session-id shell-123 --log-path validation/typecheck.log

bun run .agents/skills/go/scripts/state.ts validation-complete \
  --state "$STATE" --id validation-001 --exit-code 0
```

Record phase costs and route workflow-only work before absorbing it:

```bash
bun run .agents/skills/go/scripts/state.ts checkpoint \
  --state "$STATE" --tokens unavailable --elapsed-seconds 1200 \
  --commit-count 4 --file-count 18

bun run .agents/skills/go/scripts/state.ts scope-admit \
  --state "$STATE" --title "General CI cleanup"
```

## Handoff and finalization

After a passing Acceptance round, move to `acceptance_handoff`, generate the
report, deliver the same summary with its stable Acceptance URL, and only then
record delivery and enter `waiting_acceptance`:

```bash
bun run .agents/skills/go/scripts/state.ts report-generate \
  --state "$STATE" --head-sha def5678

bun run .agents/skills/go/scripts/state.ts report-delivered \
  --state "$STATE" --head-sha def5678 --acceptance-url "https://app.lobehub.com/..."
```

If the user explicitly waives desktop Acceptance for a non-product exact head,
record `status=waived`, `waived-head-sha`, and the reason. The report still must
be generated before merge and delivered before completion.

After merge and refreshed remote verification:

```bash
bun run .agents/skills/go/scripts/state.ts finalization-generate \
  --state "$STATE" --head-sha def5678 --merge-sha fed9876 \
  --issue 42:CLOSED:Done

bun run .agents/skills/go/scripts/state.ts finalization-delivered --state "$STATE"
```

The ledger rejects `waiting_acceptance` when the report is absent, incomplete,
stale, checksum-invalid, or undelivered. It rejects `complete` until the same
exact-head handoff and finalization receipts exist, their files match the
ledger, the PR is merged, and every intended issue is `CLOSED` / `Done`.

## Resume and rules

```bash
bun run .agents/skills/go/scripts/state.ts resume --state "$STATE" --json
bun run .agents/skills/go/scripts/state.ts validate --state "$STATE"
```

- Update state only through the script; writes are atomic.
- Treat GitHub and LobeHub as authoritative and refresh at delivery boundaries.
- Recording a changed PR head invalidates fallback evidence, report/finalization
  receipts, and any freeze that does not already bind the replacement head.
- Recover pending validations from their recorded session/log before retrying.
- Do not rerun a passed exact-head validation without invalidation.
- Preserve original zero-step billing evidence and keep hosted CI externally
  blocked when the guarded fallback passes.
- Store raw logs in the run directories, not in `state.json`; never copy the
  Codex transcript into the run record.
- Explicitly assess expectation drift for each issue commit. `detected` blocks
  issue completion, PR readiness, and finalization until its comment URL is
  recorded. `decision_required` remains blocked after commenting until a new
  resolved decision revision is published. Identical resume attempts reuse the
  existing comment URL and never post duplicates.

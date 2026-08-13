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

Publish a finalized round through the exact-lineage wrapper:

```bash
bun run .agents/skills/go/scripts/state.ts acceptance-publish \
  --state "$STATE" --report-dir "$REPORT_DIR" --head-sha def5678
```

The command stores the stable Acceptance id/URL, immutable run id, round index,
head, check ids, and verdict only after an exact remote readback. For an earlier
accidental standalone, use `acceptance-orphan` to retain its id, run id, and
reason without replacing the frozen lineage. When ingest succeeds but readback
fails, `resume` points to the persisted pending attempt and the same command
retries only remote readback.

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

Use command-level help instead of guessing option order or enum values:

```bash
bun run .agents/skills/go/scripts/state.ts help validation-start
bun run .agents/skills/go/scripts/state.ts phase --help
```

- Update state only through the script. Every command acquires an atomic per-run lock directory and
  fails closed when another process owns it. If a process is forcibly killed, remove `state.lock`
  only after verifying that no state command for that exact run is alive; then retry. State and
  history artifacts use exclusive unpredictable temporary files, ownership/no-follow checks, and
  atomic replacement.
- Do not call raw `lobehub acceptance run ingest` inside Go. A `pending`
  Acceptance without verified publication history, or with a stale exact head,
  cannot enter handoff or survive ledger validation.
- Treat GitHub and LobeHub as authoritative and refresh at delivery boundaries.
- Recording a changed PR head invalidates fallback evidence, report/finalization
  receipts, and any freeze that does not already bind the replacement head.
- Recover pending validations from their recorded session/log before retrying.
- Do not rerun a passed exact-head validation without invalidation.
- Preserve original zero-step billing evidence and keep hosted CI externally
  blocked when the guarded fallback passes.
- Store raw logs in the run directories, not in `state.json`; never copy the
  Codex transcript into the run record.
- Notes are typed, limited to 4,096 characters, and secret-shaped values are redacted before they
  enter the ledger. Long-lived collections are capped; overflow is stored in a content-addressed
  `artifacts/ledger-history-<sha256>.json` file whose count, per-collection summary, and digest stay
  in `state.json`. Archives fail closed at 8 MiB, and ordinary resume validates only their direct
  file metadata; inspect the artifact only for a targeted audit.
- Git, GitHub, and LobeHub child processes share a bounded runner: 60-second default timeout,
  combined stdout/stderr byte ceiling, TERM-to-KILL escalation, and byte-count-only failure
  evidence. `issue-drift` scans at most ten 100-comment pages and stops as soon as its marker is
  found.
- Explicitly assess expectation drift for each issue commit. `detected` blocks
  issue completion, PR readiness, and finalization until its comment URL is
  recorded. `decision_required` remains blocked after commenting until a new
  resolved decision revision is published. Identical resume attempts reuse the
  existing comment URL and never post duplicates.

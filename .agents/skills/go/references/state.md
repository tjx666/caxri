# Durable Run State

Use `.agents/skills/go/scripts/state.ts` to maintain a compact JSON resume index
under `.records/go/`. `.records/` is local and gitignored.

## Commands

Initialize and retain the printed state path:

```bash
bun run .agents/skills/go/scripts/state.ts init --objective "<business goal>"
```

Transition phases:

```bash
bun run .agents/skills/go/scripts/state.ts phase \
  --state "$STATE" --phase issue_execution --reason "Goal created"
```

Upsert issue state and append deduplicated artifacts:

```bash
bun run .agents/skills/go/scripts/state.ts issue \
  --state "$STATE" --number 42 --title "修复 Terminal 内边距" \
  --status progressing --priority P0 \
  --check issue-42-terminal-inset

bun run .agents/skills/go/scripts/state.ts issue \
  --state "$STATE" --number 42 --status complete \
  --commit abc1234 --validation "focused Electron test passed"
```

Record PR and Acceptance state:

```bash
bun run .agents/skills/go/scripts/state.ts pr \
  --state "$STATE" --number 123 --url "https://github.com/..." \
  --status open --head-sha abc1234

# A required hosted check could not start because of external infrastructure.
bun run .agents/skills/go/scripts/state.ts pr \
  --state "$STATE" --status checks_blocked --head-sha abc1234

# Admit only after verifying a zero-step external failure and receiving
# separate explicit user authorization.
bun run .agents/skills/go/scripts/state.ts ci-fallback-admit \
  --state "$STATE" --head-sha abc1234 --failure-kind billing \
  --failure-url "https://github.com/.../actions/runs/..." \
  --failure-job checks --failure-detail "Rejected before runner allocation" \
  --authorization "User explicitly authorized local fallback" \
  --verified-zero-steps

bun run .agents/skills/go/scripts/state.ts ci-fallback-result \
  --state "$STATE" --head-sha abc1234 \
  --platform-command "bun run lint" \
  --platform-command "bun run knip" \
  --platform-command "bun run doctor" \
  --platform-command "bun run typecheck" \
  --platform-command "bun run format:check" \
  --platform-command "bun run format:md:check" \
  --platform-command "bun run test" \
  --platform-command "bun run build" \
  --platform-result passed --e2e-command "bun run test:e2e" \
  --e2e-result passed

bun run .agents/skills/go/scripts/state.ts acceptance \
  --state "$STATE" --id acc_xxx --url "https://app.lobehub.com/acceptance/acc_xxx" \
  --round 2 --status pending

bun run .agents/skills/go/scripts/state.ts acceptance \
  --state "$STATE" --status accepted --accepted-head-sha abc1234
```

Record durable observations:

```bash
bun run .agents/skills/go/scripts/state.ts note \
  --state "$STATE" --kind workflow --text "在综合 review 后再捕获最终证据"
```

Inspect or validate:

```bash
bun run .agents/skills/go/scripts/state.ts resume --state "$STATE" --json
bun run .agents/skills/go/scripts/state.ts show --state "$STATE"
bun run .agents/skills/go/scripts/state.ts validate --state "$STATE"
```

Use `resume --json` after context compaction or handoff. It derives the next
action and emits only the current issue, PR/Acceptance heads and statuses,
fallback evidence, blockers, last phase transition, and unfinished issue
summaries. During Acceptance it also emits only the three newest material
workflow observations for the user handoff. Use `show` only for a full ledger
audit; it intentionally includes all events, validations, and notes.

## Rules

- Update state only through the script so writes are atomic and transitions are
  checked.
- Treat GitHub and LobeHub as authoritative; refresh them at delivery boundaries.
- Record the current PR head before Acceptance and the exact human-accepted head
  before entering `merge`; the ledger rejects a mismatch.
- Keep `pullRequest.status` as `checks_blocked` when local fallback passes. The
  ledger distinguishes substitute evidence from a green hosted check.
- Recording a different PR head invalidates the current fallback admission and
  results. Verify the replacement hosted run before considering a new fallback.
- Keep observations concise. Store raw logs and reports beside the ledger rather
  than inside it. Write `workflow` observations in Simplified Chinese because
  the Acceptance handoff exposes them directly.
- Never commit `.records/`.

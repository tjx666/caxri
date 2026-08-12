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

# Product P0/P1 must be zero to freeze the reviewed head.
bun run .agents/skills/go/scripts/state.ts review \
  --state "$STATE" --head-sha abc1234 --mode full \
  --p0 0 --p1 0 --scope "Goal-range product review" --freeze

# If the first post-round-three targeted verification exposes another architecture
# P0/P1 and the user authorizes its repair plus one final targeted verification:
bun run .agents/skills/go/scripts/state.ts review \
  --state "$STATE" --head-sha def5678 --mode targeted \
  --p0 0 --p1 0 --scope "Authorized architecture repair" --freeze \
  --authorization "User explicitly authorized one final targeted verification"

# After the three routine delivery verification freezes, every additional
# delivery-infrastructure repair requires its own explicit authorization:
bun run .agents/skills/go/scripts/state.ts review \
  --state "$STATE" --head-sha fed9876 --mode verification \
  --p0 0 --p1 0 --scope "Authorized delivery-infrastructure repair" --freeze \
  --verification-cap-authorization "User explicitly authorized this exact exception"

# A required hosted check could not start because of external infrastructure.
bun run .agents/skills/go/scripts/state.ts pr \
  --state "$STATE" --status checks_blocked --head-sha abc1234

# Verified payment/spending-limit failures use automatic Go policy authorization.
bun run .agents/skills/go/scripts/state.ts ci-fallback-admit \
  --state "$STATE" --head-sha abc1234 --failure-kind billing \
  --failure-url "https://github.com/.../actions/runs/..." \
  --failure-job checks \
  --failure-detail "The job was not started because the spending limit was reached" \
  --verified-zero-steps

# For another infrastructure failure, add explicit user authorization:
# --authorization "User explicitly authorized this exact-head fallback"

bun run .agents/skills/go/scripts/state.ts ci-fallback-result \
  --state "$STATE" --head-sha abc1234 \
  --platform-command "bun run lint" \
  --platform-command "bun run knip" \
  --platform-command "bun run doctor:changed" \
  --platform-command "bun run typecheck" \
  --platform-command "bun run format:check" \
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
During `self_improvement` and `reporting`, compact resume includes up to 20
workflow and token-waste notes. If it reports truncation, read only the complete
note sets with `state.ts notes --state "$STATE" --json`; do not load the full
event history.

## Rules

- Update state only through the script so writes are atomic and transitions are
  checked.
- Treat GitHub and LobeHub as authoritative; refresh them at delivery boundaries.
- Record the current PR head before Acceptance and the exact human-accepted head
  before entering `merge`; the ledger rejects a mismatch.
- Keep `pullRequest.status` as `checks_blocked` when local fallback passes. The
  ledger distinguishes substitute evidence from a green hosted check.
- Recording a different PR head invalidates the current fallback admission and
  results plus its review freeze. Verify the replacement hosted run and record a
  clean exact-head full, targeted, or eligible verification decision before
  considering a new fallback.
- Full Goal-range review decisions are limited to three per run. Record at most
  one targeted P0/P1 repair verification after each full round. If that
  verification exposes another architecture-level P0/P1, a user-authorized
  repair may receive one final targeted verification recorded with
  `--authorization`; a third in that post-round-three sequence is forbidden.
  Before the full-review ceiling, delivery repairs retain one targeted decision
  after the latest full baseline. Do not disguise a full review as targeted.
  `--freeze` rejects any decision with a nonzero product P0 or P1 count.
- A `verification` decision is reserved for workflow, test-infrastructure,
  evidence, or PR-metadata-only commits. It requires a prior full review, zero
  product P0/P1, and `--freeze`; the ledger permits one bookkeeping freeze during
  `deep_review` plus three routine repair freezes during `delivery`. Up to three
  additional delivery freezes each require exact user authorization recorded with
  `--verification-cap-authorization`; a seventh delivery freeze is rejected.
- The fallback admission command rejects an unfrozen or stale PR head. The
  ledger retains full Electron E2E history across head changes and rejects a
  third full run; a prior passing run can be repeated only after human
  Acceptance rejected that delivered head.
- Keep observations concise. Store raw logs and reports beside the ledger rather
  than inside it. Record observed repeated reads, oversized output, duplicate
  validation, or polling as `token_waste`; record reusable automation ideas as
  `workflow`. Write `workflow` observations in Simplified Chinese because the
  Acceptance handoff exposes them directly.
- For automatic billing fallback, preserve the original GitHub payment,
  billing, or spending-limit failure text in `--failure-detail`; the ledger
  includes it in policy authorization evidence.
- Never commit `.records/`.

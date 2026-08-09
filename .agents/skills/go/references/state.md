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
  --state "$STATE" --number 42 --title "Fix terminal inset" \
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

bun run .agents/skills/go/scripts/state.ts acceptance \
  --state "$STATE" --id acc_xxx --url "https://app.lobehub.com/acceptance/acc_xxx" \
  --round 2 --status pending

bun run .agents/skills/go/scripts/state.ts acceptance \
  --state "$STATE" --status accepted --accepted-head-sha abc1234
```

Record durable observations:

```bash
bun run .agents/skills/go/scripts/state.ts note \
  --state "$STATE" --kind workflow --text "Capture after aggregate review"
```

Inspect or validate:

```bash
bun run .agents/skills/go/scripts/state.ts resume --state "$STATE" --json
bun run .agents/skills/go/scripts/state.ts show --state "$STATE"
bun run .agents/skills/go/scripts/state.ts validate --state "$STATE"
```

Use `resume --json` after context compaction or handoff. It derives the next
action and emits only the current issue, PR/Acceptance heads and statuses,
blockers, last phase transition, and unfinished issue summaries. Use `show` only
for a full ledger audit; it intentionally includes all events, validations, and
notes.

## Rules

- Update state only through the script so writes are atomic and transitions are
  checked.
- Treat GitHub and LobeHub as authoritative; refresh them at delivery boundaries.
- Record the current PR head before Acceptance and the exact human-accepted head
  before entering `merge`; the ledger rejects a mismatch.
- Keep observations concise. Store raw logs and reports beside the ledger rather
  than inside it.
- Never commit `.records/`.

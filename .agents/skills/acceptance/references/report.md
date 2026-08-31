# Caxri structured Acceptance rounds

Publish each Caxri verification attempt as an immutable structured report. The
acceptance root freezes one requirement shared by all rounds. Each report is an
immutable `round-<n>` child:

```text
<acceptance-root>/
├── requirement.txt
└── round-<n>/
    ├── result.json
    ├── report.md
    └── assets/
```

`result.json` is the rendered report and source of truth. `report.md` starts with
a visible Chinese “no additional notes” statement; replace it with concise round
notes, follow-ups, or limitations when needed, and do not duplicate the case
table there.

## Contents

- [Language contract](#language-contract)
- [Initialize from the frozen plan](#initialize-from-the-frozen-plan)
- [Record observations](#record-observations)
- [Finalize before publication](#finalize-before-publication)
- [Publish immutable history](#publish-immutable-history)
- [Before and after evidence](#before-and-after-evidence)

## Language contract

Write human-facing Acceptance content in Simplified Chinese. This includes the
immutable requirement, report title and entry, plan title/category/method/
expected behavior, case name/category/observation, summary conclusion,
comparison labels, and `report.md` notes. Keep stable ids, enum values, code
identifiers, branches, commits, commands, and artifact paths in English.

## Initialize from the frozen plan

Before executing a product surface, freeze a `plan.json` array. Each item
contains:

```json
[
  {
    "id": "issue-42-terminal-layout",
    "title": "终端内容填满工作区",
    "category": "终端布局",
    "verifier": "agent",
    "method": "启动隔离的 Caxri 并检查稳定后的终端布局",
    "expected": "终端视口周围不出现应用背景色条",
    "requiredEvidence": ["screenshot", "dom_snapshot"],
    "fixturePreflight": "terminal",
    "agentFixture": "agent-features-v1",
    "stateIsolation": { "mode": "isolated" },
    "surface": "desktop"
  }
]
```

Use stable ids tied to the owning GitHub issue. A planned item with no matching
case remains visibly unexecuted; never delete it to make coverage look complete.
Use `surface: "desktop"` for macOS Electron and `surface: "mobile"` for Android or iOS. The
scaffold defaults an omitted surface to `desktop`, copies each planned surface into its case
placeholder, and derives the top-level `surfaces[]` list. Finalization rejects a case whose surface
drifts from the frozen plan.

Every mobile plan item also freezes its exact target:

```json
{
  "mobileDevice": {
    "appId": "com.caxri.mobile",
    "deviceId": "emulator-5554",
    "platform": "android"
  },
  "surface": "mobile"
}
```

Its case evidence must include `assets/<case-id>-mobile-device.json`. Finalization parses that
receipt and rejects a different platform, app id, device id, report commit, or final lifecycle
launch. For `readonly_checkpoint`, it instead requires the frozen checkpoint id and no lifecycle
receipt. When `assets/<case-id>-result.json` is cited, finalization binds it to the same commit and
isolation identity. This binds screenshots and behavior to the selected target instead of an
ambient emulator, Simulator, stale install, or prior retry.

Create the round scaffold only after the plan is frozen:

```bash
bun run .agents/skills/acceptance/scripts/report.ts init \
  --dir "$REPORT_DIR" \
  --plan "$PLAN_PATH" \
  --title "$TITLE" \
  --entry "$ENTRY" \
  --requirement "$REQUIREMENT" \
  --branch "$BRANCH" \
  --commit "$COMMIT" \
  --pull-request "$PR_NUMBER"
```

The command refuses to overwrite an existing round. It creates `result.json`, a
Chinese default `report.md`, `assets/`, and one visible `TODO` case placeholder
per plan item. The round must be inside this repository's `.records/` directory
and its name must match `round-<positive integer>`. The first round writes the
shared `requirement.txt`; later rounds and finalization must match it exactly.

If a non-product repair changes the exact delivery head before the round is
finalized or published, rebind the generated scaffold through the structured
command instead of projecting or patching `result.json` manually:

```bash
bun run .agents/skills/acceptance/scripts/report.ts rebind-head \
  --dir "$REPORT_DIR" \
  --from-commit "$OLD_HEAD" \
  --commit "$NEW_HEAD" \
  --entry "$ENTRY" \
  --reason "$REBIND_REASON"
```

The command atomically checks the expected old head, updates `commit`, `entry`,
and `createdAt`, and appends an audit record. It rejects finalized reports. A
product-affecting repair requires a fresh round and fresh product-surface evidence;
never rebind a published immutable round.

## Record observations

Replace each generated `cases[]` placeholder with the observed result:

```json
{
  "id": "issue-42-terminal-layout",
  "name": "终端内容填满工作区",
  "category": "终端布局",
  "surface": "desktop",
  "status": "pass",
  "observation": "终端与工作区使用对比色后，没有观察到未覆盖的背景色条",
  "evidence": ["assets/terminal-layout.png", "assets/terminal-layout-dom.html"]
}
```

`status` is `pass`, `fail`, or `blocked`. A blocked case is not a pass. Every
status needs evidence, and every artifact path is relative to the round directory.
For isolated and restart cases, include the adapter-generated
`assets/<case-id>-state-isolation.json`; finalization requires completed cleanup and, for restart,
one exact profile identity across launches. A plan with `fixturePreflight: terminal` must also
include the ready `assets/<case-id>-fixture-preflight.json` receipt.

A plan may declare the fixed `agentFixture: "agent-features-v1"` only when the case needs fake
Claude Code or Codex processes. Launch with the matching `--agent-fixture` value and include
`assets/<case-id>-agent-fixture.json` in the case evidence. Finalization requires the receipt to
match the frozen id and every fixture launch to have completed owned-profile cleanup.

An isolated case may retry after a ready launch when setup, fixture preflight, or evidence capture
fails. Stop and fully clean the previous launch first, then start again with a fresh isolated
profile. The lifecycle receipt preserves every attempt; finalization accepts the history only when
at least one launch became ready and every attempt completed cleanup.

## Finalize before publication

After every placeholder has an observed `pass`, `fail`, or `blocked` result,
finalize the report locally:

```bash
bun run .agents/skills/acceptance/scripts/report.ts finalize \
  --dir "$REPORT_DIR" \
  --requirement "$REQUIREMENT"
```

The finalizer requires case ids and order to match the frozen plan, verifies
that referenced files exist under `assets/`, checks every declared evidence
medium, validates Simplified Chinese report prose, and writes `summary` from the
case statuses. Pass `--conclusion` only when the generic Chinese conclusion is
not precise enough. It never writes observations or changes case verdicts.

Evidence type follows the LobeHub ingest extension mapping. Supported required
types are `screenshot`, `gif`, `video`, `text`, `markdown`, and `dom_snapshot`.
In particular, save a required DOM snapshot with `.html` or `.htm`, Markdown
with `.md` or `.markdown`, and text or transcript-like output with `.txt`. The
current file ingest cannot encode a `transcript` evidence type.

## Publish immutable history

Create the standalone Acceptance with the first round:

```bash
ROUND_DIR="${REPORT_DIR%/}"
REQUIREMENT_PATH="$(dirname "$ROUND_DIR")/requirement.txt"
if [ ! -s "$REQUIREMENT_PATH" ]; then
  echo "Frozen Acceptance requirement is missing: $REQUIREMENT_PATH" >&2
  false
else
  FROZEN_REQUIREMENT="$(cat "$REQUIREMENT_PATH")"
  lobehub acceptance run ingest "$ROUND_DIR" \
    --source agent-testing \
    --requirement "$FROZEN_REQUIREMENT" \
    --json
fi
```

Preserve the returned Acceptance id and URL. Append every repair as a new round:

```bash
lobehub acceptance run ingest "$REPORT_DIR" \
  --source agent-testing \
  --acceptance "$ACCEPTANCE_ID" \
  --json
```

When Go owns the delivery, replace both raw ingest commands with the fail-closed
wrapper after `finalize`:

```bash
bun run .agents/skills/go/scripts/state.ts acceptance-publish \
  --state "$STATE" --report-dir "$REPORT_DIR" --head-sha "$HEAD_SHA"
```

The wrapper persists `acceptanceId`, stable URL, immutable run id, round index,
exact head, check ids, and verdict only after `lobehub acceptance view` returns
the same lineage. Empty stdout, network interruption, wrong id/index/head/checks,
or verdict mismatch leaves the ledger unpublished. If ingest returns an immutable
run before readback fails, resume stores that attempt and retries only `view`; it
never ingests the same local round twice. If a round was accidentally created as
a separate standalone, preserve it in the audit trail:

```bash
bun run .agents/skills/go/scripts/state.ts acceptance-orphan \
  --state "$STATE" --acceptance-id "$ORPHAN_ID" \
  --verify-run-id "$ORPHAN_RUN_ID" --reason "误建 standalone，保留不可变历史。"
```

Before a repair, read only the decision fields needed for routing, then fetch
actionable feedback. Avoid loading the full aggregate into chat context because
it can contain unrelated identities and signed artifact URLs:

```bash
lobehub acceptance view "$ACCEPTANCE_ID" --json |
  jq '{status: .acceptance.status, userDecision: .rounds[-1].run.userDecision}'
lobehub acceptance feedback "$ACCEPTANCE_ID" --actionable --json
```

- Never overwrite a prior round or hide a failed attempt.
- Reuse rejected stable ids. A semantic replacement declares its complete
  `supersedes` lineage.
- Omit accepted checks unless the repair can regress them.
- Publish only the stable Acceptance URL in the final handoff, never local
  report paths or internal round URLs.

## Before and after evidence

For the same view in two states, use a comparison pair with a shared id:

```json
[
  {
    "path": "assets/before.png",
    "comparison": {
      "id": "terminal-layout",
      "role": "before",
      "layout": "horizontal",
      "label": "修复前"
    }
  },
  {
    "path": "assets/after.png",
    "comparison": {
      "id": "terminal-layout",
      "role": "after",
      "layout": "horizontal",
      "label": "修复后"
    }
  }
]
```

Use `horizontal` for normal full-window comparisons and `vertical` only when
preserving the width of a shallow region matters. Sequential interaction steps
are ordinary ordered evidence, not a comparison pair.

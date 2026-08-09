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

Before executing the desktop path, freeze a `plan.json` array. Each item
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
    "requiredEvidence": ["screenshot", "dom_snapshot"]
  }
]
```

Use stable ids tied to the owning GitHub issue. A planned item with no matching
case remains visibly unexecuted; never delete it to make coverage look complete.

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

Evidence for LobeHub publication follows Caxri's schema. Supported required
types are `screenshot`, `gif`, `video`, `text`, `markdown`, and `dom_snapshot`.
In particular, save a required DOM snapshot with `.html` or `.htm`, Markdown
with `.md` or `.markdown`, and text or transcript-like output with `.txt`. The
schema does not define a `transcript` evidence type.

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

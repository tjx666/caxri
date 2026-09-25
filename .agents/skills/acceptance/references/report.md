# Caxri structured Acceptance rounds

Publish each Caxri verification attempt as an immutable structured report. The
acceptance root freezes one requirement shared by all rounds. Each report is an
immutable `round-<n>` child:

```text
<acceptance-root>/
├── requirement.txt
└── round-<n>/
    ├── result.json
    ├── proposal.md
    ├── report.md
    └── assets/
```

`result.json` is the rendered report and source of truth. `report.md` starts with
a visible Chinese “no additional notes” statement; replace it with concise round
notes, follow-ups, or limitations when needed, and do not duplicate the case
table there.

`proposal.md` is this round's own note to the reviewer: what the round delivers
and where you want their eyes, the way a person writes a pull request
description — a few sentences, in Simplified Chinese. `ingest` posts it into the
acceptance's discussion as a message on this round, so it is the first thing a
reviewer reads and they can answer it in place. It is NOT the verification
write-up: do not restate the checks or the verdict, those are `result.json` and
`report.md`. The first round says what the delivery is; later ones say what
changed since the feedback. `finalize` refuses the scaffolded placeholder, so
every published round carries a real note.

## Contents

- [Language contract](#language-contract)
- [Initialize from the frozen plan](#initialize-from-the-frozen-plan)
- [Record observations](#record-observations)
- [Closed vocabularies](#closed-vocabularies)
- [Structured visualizations](#structured-visualizations)
- [Finalize before publication](#finalize-before-publication)
- [Publish immutable history](#publish-immutable-history)
- [Before and after evidence](#before-and-after-evidence)

## Language contract

Write human-facing Acceptance content in Simplified Chinese. This includes the
immutable requirement, report title and entry, plan title/category/method/
expected behavior, case name/category/observation, summary conclusion, evidence
descriptions, comparison labels, visualization titles, and the `report.md` and
`proposal.md` prose. Keep stable ids, enum values, code identifiers, branches,
commits, commands, and artifact paths in English.

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
isolation identity. A mobile plan may freeze media provenance, for example
`{"type":"screenshot","source":"android-framebuffer"}` and
`{"type":"screenshot","source":"isolated-desktop-renderer"}`. A source-qualified requirement
needs a cited media entry with the same `source`, so a Desktop image cannot satisfy an Android
image requirement. Every cited Android or iOS screenshot or recording must have one matching device
receipt entry:

```json
{
  "path": "assets/MOB-ACC-02-android.png",
  "sha256": "<64 lowercase hex characters>",
  "source": "android-framebuffer",
  "type": "screenshot"
}
```

The device artifact list must match the cited device media exactly. Finalization recomputes each
hash, requires framebuffer provenance to match the frozen platform, and accepts mobile screenshots
only as PNG framebuffer bytes. When the case also cites isolated Desktop media, include
`assets/<case-id>-desktop-capture.json` and tag each Desktop media evidence entry with
`"source":"isolated-desktop-renderer"`. That receipt must bind the same case, report commit,
launch id, mobile device serial, removed Desktop profile, process start identity, CDP target, and
selected Session identity. It lists exactly the `before` and `after` PNGs, plus an optional
full-duration `assets/MOB-E2E-01-desktop.mp4` for `MOB-E2E-01`. Each listed media path and hash is
verified separately; the Desktop files cannot enter the device artifact list. The optional Desktop
video may be visually static because it proves a stable selection. Only a verified Desktop capture
receipt grants that exception; duration and frame-count checks still run, and the probed duration
must match the receipt within 750 ms. Its recording receipt also binds the exact start/end interval,
2 Hz encoded sample count, at least two live Renderer samples, and a maximum 1500 ms gap between
live captures. `MOB-E2E-01` may carry an Android framebuffer recording up to 180 seconds only when
that canonical video is in its verified device receipt. The usual 120-second limit remains for
other videos, and the Android journey still needs enough distinct frames to show real interaction.

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
Chinese default `report.md`, a `proposal.md` placeholder, `assets/`, and one
visible `TODO` case placeholder per plan item. The round must be inside this
repository's `.records/` directory and its name must match
`round-<positive integer>`. The first round writes the shared `requirement.txt`;
later rounds and finalization must match it exactly.

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
and `createdAt`, and appends an audit record.

An already-finalized round may still follow the head, because finalization is a
local recompute and only the LobeHub ingest is irreversible. That path needs
`--allow-finalized`, and the command then resolves both revisions with
`git rev-parse` and reads the real `<old>..<new>` diff with rename detection
off, refusing unless every changed path is under `.agents/`. It drops the
round's `summary`, so the round cannot be published before you re-run
`finalize`. A free-text `--reason` never substitutes for that check.

Publication is recorded in the Go ledger, not in `result.json`, so this command
cannot detect it; `--allow-finalized` is you stating the round is unpublished.
Never rebind a published immutable round, and a product-affecting repair always
requires a fresh round with fresh product-surface evidence.

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
  "evidence": [
    {
      "path": "assets/terminal-layout.png",
      "description": "切换到首个 Session 后的终端截图，视口四周没有露出应用背景色条。"
    },
    {
      "path": "assets/terminal-layout-dom.html",
      "description": "同一时刻的终端 DOM 快照，用于核对视口尺寸与容器边界。"
    }
  ]
}
```

Every evidence entry is an object with `path` and a non-empty, reviewer-facing
`description`. Describe the file's contents and why it matters for this check —
a filename, path, id, or a generic word like “证据” is not sufficient, and the
bare-path form is rejected rather than falling back to the filename. Describe
each artifact separately instead of repeating the check title for every file.

`status` is `pass`, `fail`, or `blocked`. A blocked case is not a pass. Every
status needs evidence, and every artifact path is relative to the round directory.
For isolated and restart cases, include the adapter-generated
`assets/<case-id>-state-isolation.json`; finalization requires completed cleanup and, for restart,
one exact profile identity across launches. A plan with `fixturePreflight: terminal` must also
include the ready `assets/<case-id>-fixture-preflight.json` receipt, bound to the report commit and
final launch id.

`blocked` is the status for a case whose planned observation could not be made, so finalization
asks it for what it does have rather than for what it could not produce. It does not have to
satisfy the plan's `requiredEvidence` medium, and it may omit the launch, fixture preflight, Agent
fixture, and mobile device receipts when the case was blocked before that step ever ran. The moment
one of those receipts exists on disk the case did execute, so it must declare that receipt and pass
the full check; `pass` and `fail` are unchanged and still owe every planned medium and receipt.
Without this, one honest blocked case would make the whole round impossible to finalize and
publish.

A blocked case still owes at least one real evidence file that supports its observation — the
covering focused test's result, a log excerpt, the extracted copy. The launch, fixture preflight,
and Agent fixture receipts do not count: they record that the adapter's own machinery ran, not what
the product did. The mobile device receipt does count, because it carries the target's `outcome`.

For a mobile action that succeeded on the selected device but missed a specific observation frozen
in the plan, set the formal case to `"status": "blocked"` and add
`"blockedReason": "plan-evidence-gap"`. Describe the missing observation concretely and cite a
supporting artifact beyond adapter and device receipts. The device receipt must exist and retain
`"status": "passed"`; the formal round remains `partial`. This exception does not relax the
frozen case, device, commit, launch, cleanup, or media provenance and hash checks. Without this
reason, a blocked case still requires a blocked device receipt when the device was reached.

A plan may declare `agentFixture: "agent-features-v1"` for fake Claude Code or Codex processes,
`agentFixture: "agent-delegation-v1"` for visible Claude/Codex/Grok task delegation with a synthetic caller,
or `agentFixture: "grok-build-v1"` for fake Grok Build. Launch with the matching `--agent-fixture` value and include
`assets/<case-id>-agent-fixture.json` in the case evidence. Finalization requires the receipt to
match the frozen id and every fixture launch to have completed owned-profile cleanup.

An isolated case may retry after a ready launch when setup, fixture preflight, or evidence capture
fails. Stop and fully clean the previous launch first, then start again with a fresh isolated
profile. The lifecycle receipt preserves every attempt; finalization accepts the history only when
at least one launch became ready and every attempt completed cleanup.

A launch the launcher could not complete itself is closed by `stop-electron.ts` with a
`forcedCompletion` record naming the source and reason. A launch the launcher completed while a
detached Server generation still held the profile records `cleanupCompleted: false` honestly; once
`stop-electron.ts` removes that profile it records `cleanupCompleted: true` with a `deferredCleanup`
marker (and the same marker on the case's Agent fixture receipt), so finalization accepts the case. If a launch is still pending after the instance is gone,
close it with an explicit reason instead of editing the file:

```bash
bun run .agents/skills/acceptance/scripts/report.ts repair-lifecycle \
  --dir .records/acceptance/<report>/round-1 --case-id <case-id> --reason "<why the launcher never completed>"
```

For an isolated case the repair verifies the profile directory is already gone before it records
cleanup; a restart launch is closed without claiming cleanup of its shared profile.

## Closed vocabularies

The pipeline acts on these values; they are not labels.

| field                           | values                                                                | what it does                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `verifier`                      | `program` / `agent` / `llm` (default `agent`)                         | How the verdict is reached. A command-asserted check is `program`; calling it `agent` hides what actually judged it. |
| `requiredEvidence`              | `screenshot` / `gif` / `video` / `text` / `markdown` / `dom_snapshot` | The artifact this check **must** produce. Finalization fails a `pass`/`fail` case whose required medium is missing.  |
| `surfaces` / per-case `surface` | `desktop` / `cli` / `mobile`                                          | The product surface a check ran **on**. A test kind (`unit`, `e2e`) or runtime mode is not a surface.                |

`category` names the user-facing requirement area (e.g. `终端布局`, `配对恢复`) —
never a technical surface. `method` / `expected` stay free Chinese prose; they
render under the check next to the outcome.

### What is not an acceptance check

The repo's own gates — Vitest, Playwright E2E, coverage, `type-check`, lint,
format, a clean build, "CI passes" — are never `plan[]` / `cases[]` items, under
any phrasing; they are one line in `report.md`. Treat a plan containing matching items as invalid,
and reject it before publication; a
gates-only plan fails local validation. Full rule: [SKILL.md](../SKILL.md).

## Structured visualizations

For metrics, time series, render-count or benchmark comparisons, distributions,
matrices, and tables, use native Acceptance visualizations instead of generating
a PNG: put review-sized values in `cases[].datasets`, declare the view in
`cases[].visualizations`, and retain the raw CSV/JSON, benchmark output, trace,
or profile in `evidence`. Native renderers preserve machine-readable values,
accessibility, theme adaptation, and consistent comparison semantics. Generate a
static chart only when no supported renderer can represent the result, and
explain that limitation in the case observation.

```json
{
  "id": "issue-51-session-switch-renders",
  "datasets": [
    {
      "id": "render-counts",
      "fields": [
        { "key": "metric", "type": "string" },
        { "key": "before", "type": "number" },
        { "key": "after", "type": "number" }
      ],
      "rows": [{ "metric": "会话切换渲染次数", "before": 11, "after": 2 }]
    }
  ],
  "visualizations": [
    {
      "id": "render-comparison",
      "type": "metric-comparison",
      "version": 1,
      "dataset": "render-counts",
      "title": "会话切换前后的渲染次数",
      "encoding": { "label": "metric", "before": "before", "after": "after" }
    }
  ]
}
```

Supported version-1 renderers and their encodings:

| Renderer            | Required encoding                                              | Optional encoding                                                                         |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `metric-comparison` | `label`, `before`, `after`                                     | `beforeSamples`, `afterSamples`, `direction`, `statistic`, `target`, `unit`               |
| `line-chart`        | `x`, non-empty `series[]`; each series requires `field`        | series `label`, series `style` (`muted` \| `primary` \| `accent`), `xLabel`, `yLabel`     |
| `bar-chart`         | `category`, non-empty `series[]`; each series requires `field` | series `label`, `valueLabel`                                                              |
| `scatter-plot`      | `x`, `y`                                                       | `color`, `label`, `xLabel`, `yLabel`                                                      |
| `heatmap`           | `x`, `y`, `value`                                              | none                                                                                      |
| `table`             | none; `encoding` itself may be omitted                         | non-empty `columns[]`; `highlights[]` entries require `field` and `mode` (`min` \| `max`) |

Dataset field `type` is one of `boolean`, `category`, `number`, `string`, or
`temporal`; field keys and dataset/view ids must be unique, rows may contain only
declared keys with string, number, boolean, or null values, and one case's
combined inline rows are limited to 10,000. Every encoding key that names a field
must reference a field that dataset declared; `xLabel`, `yLabel`, `valueLabel`,
`unit`, `statistic`, and `direction` are free prose, not field names.
Finalization checks all of this locally, so local validation rejects a
malformed visualization shape before publication can degrade the
evidence.

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
medium and its reviewer-facing description, validates any declared datasets and
visualizations, refuses the scaffolded `proposal.md` placeholder, validates
Simplified Chinese report prose, and writes `summary` from the case statuses.
Pass `--conclusion` only when the generic Chinese conclusion is not precise
enough. It never writes observations or changes case verdicts.

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
  lh acceptance run ingest "$ROUND_DIR" \
    --source agent-testing \
    --requirement "$FROZEN_REQUIREMENT" \
    --json
fi
```

`--requirement` records the durable goal of the whole acceptance on the first
ingest only; it is immutable afterwards. `--source agent-testing` is already the
default and stays explicit here so the Go readback can match it. Do not pass
`--subject`: Caxri rounds are standalone, and a subject is only for a Task,
Topic, or Document the caller explicitly named. The command uploads cases,
evidence, `report.md`, and `proposal.md`, and prints `/acceptance/<acceptanceId>`
plus its `?r=<roundIndex>` snapshot form.

Preserve the returned Acceptance id and URL. Append every repair as a new round:

```bash
lh acceptance run ingest "$REPORT_DIR" \
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
exact head, check ids, and verdict only after `lh acceptance view` returns
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
lh acceptance view "$ACCEPTANCE_ID" --json |
  jq '{status: .acceptance.status, userDecision: .rounds[-1].run.userDecision}'
lh acceptance feedback "$ACCEPTANCE_ID" --actionable --json
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
    "description": "修复前的终端视口，右侧和底部各露出一条应用背景色。",
    "comparison": {
      "id": "terminal-layout",
      "role": "before",
      "layout": "horizontal",
      "label": "修复前：残留 12px 背景色条"
    }
  },
  {
    "path": "assets/after.png",
    "description": "同一 Session 修复后的终端视口，四周没有残留背景色条。",
    "comparison": {
      "id": "terminal-layout",
      "role": "after",
      "layout": "horizontal",
      "label": "修复后：无背景色条"
    }
  }
]
```

Use `horizontal` for normal full-window comparisons and `vertical` only when
preserving the width of a shallow region matters. Sequential interaction steps
are ordinary ordered evidence, not a comparison pair.

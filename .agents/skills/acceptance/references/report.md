# Caxri structured Acceptance rounds

Publish each Caxri verification attempt as an immutable structured report. The
report directory contains:

```text
<round-dir>/
├── result.json
├── report.md
└── assets/
```

`result.json` is the rendered report and source of truth. `report.md` contains
only concise round notes, follow-ups, and limitations; do not duplicate the case
table there.

## Author the plan first

Before executing the desktop path, freeze `plan[]`. Each item contains:

```json
{
  "id": "issue-42-terminal-layout",
  "title": "Terminal content fills the workspace",
  "category": "Terminal layout",
  "verifier": "agent",
  "method": "Launch isolated Caxri and inspect the settled terminal layout",
  "expected": "No app-background strip is visible around the terminal viewport",
  "requiredEvidence": ["screenshot", "dom_snapshot"]
}
```

Use stable ids tied to the owning GitHub issue. A planned item with no matching
case remains visibly unexecuted; never delete it to make coverage look complete.

## Record observations

Fill one `cases[]` entry for each executed plan item:

```json
{
  "id": "issue-42-terminal-layout",
  "name": "Terminal content fills the workspace",
  "category": "Terminal layout",
  "surface": "desktop",
  "status": "pass",
  "observation": "Contrasting terminal and workspace colors show no uncovered strip",
  "evidence": ["assets/terminal-layout.png", "assets/terminal-layout-dom.txt"]
}
```

`status` is `pass`, `fail`, or `blocked`. A blocked case is not a pass. Every
status needs evidence, and every artifact path is relative to the round directory.

## Complete result.json

```json
{
  "branch": "fix/terminal-layout",
  "cases": [],
  "commit": "0123456789abcdef",
  "createdAt": "2026-08-09T12:00:00+08:00",
  "entry": "Caxri Electron: open the first Session terminal",
  "plan": [],
  "pullRequest": 123,
  "summary": {
    "total": 1,
    "passed": 1,
    "failed": 0,
    "blocked": 0,
    "verdict": "pass",
    "conclusion": "The current PR head satisfies the planned desktop check."
  },
  "surfaces": ["desktop"],
  "title": "Verify Caxri terminal layout"
}
```

`summary.verdict` is `pass`, `fail`, or `partial`. Keep `surfaces` and every case
`surface` set to `desktop`. Required evidence values are `screenshot`, `gif`,
`video`, `text`, `dom_snapshot`, or `transcript`.

## Publish immutable history

Create the standalone Acceptance with the first round:

```bash
lobehub acceptance run ingest "$REPORT_DIR" \
  --source agent-testing \
  --requirement "$REQUIREMENT" \
  --json
```

Preserve the returned Acceptance id and URL. Append every repair as a new round:

```bash
lobehub acceptance run ingest "$REPORT_DIR" \
  --source agent-testing \
  --acceptance "$ACCEPTANCE_ID" \
  --json
```

Before a repair, read the aggregate and actionable feedback:

```bash
lobehub acceptance view "$ACCEPTANCE_ID" --json
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
      "label": "Before repair"
    }
  },
  {
    "path": "assets/after.png",
    "comparison": {
      "id": "terminal-layout",
      "role": "after",
      "layout": "horizontal",
      "label": "After repair"
    }
  }
]
```

Use `horizontal` for normal full-window comparisons and `vertical` only when
preserving the width of a shallow region matters. Sequential interaction steps
are ordinary ordered evidence, not a comparison pair.

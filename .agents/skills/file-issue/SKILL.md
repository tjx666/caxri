---
name: file-issue
description: 'Draft and directly file a well-formed GitHub issue for this repository, add it to the owner Caxri project, and keep its Status current as the work moves. Explicit invocation authorizes creation without a preview or confirmation. Use whenever creating an issue with gh — a bug report, an enhancement, or a follow-up task spun out of the current conversation — when the user asks to 提 issue / file an issue, or when starting, blocking, or finishing work tracked by an existing issue.'
---

# File Issue

Turn a bug, an idea, or a conclusion from the current conversation into a GitHub issue on this
repository. The issue must be self-contained: a fresh agent (or the user three weeks later) should
be able to pick it up without this conversation's context.

## Title

- Simplified Chinese, outcome-oriented, and ≤ 70 characters: “移除遮挡 Terminal 的恢复浮层”, not
  “Bug：浮层有问题” or “正在修复浮层”.
- No `[Bug]` / `feat:` prefixes — labels carry the classification.
- Use the repo's domain vocabulary with its capitalization: Project, Session, Terminal, Agent,
  Runtime, Renderer.

## Body structure

Write naturally under these sections. Bugs and enhancements emphasize different halves. Keep
`UX 设计` and `Acceptance 方案` in every issue; when the work has no direct UI or interaction
change, state that explicitly instead of inventing a visual claim.

- **问题** — every issue starts here. For a bug: observed behavior, expected behavior, and
  reproduction steps or the triggering condition. For an enhancement: the friction or gap, from
  the user's perspective.
- **诊断** (bug) — root cause if known, citing the load-bearing code as `path/to/file.ts:42` or
  symbol names. State clearly when the cause is a hypothesis, not confirmed.
- **目标** (enhancement) — the end state in one or two sentences: what works afterwards that
  doesn't today.
- **UX 设计** — describe the user scenario, entry point, interaction flow, visible states, copy,
  keyboard behavior, and accessibility expectations affected by the issue. For non-UI architecture
  work, write `不涉及直接 UI 变化` and name the nearest user-visible outcome or explain why none
  exists.
- **方案 / 修复方案** — the approach, numbered when there are ordered steps. Mention schema
  migrations, IPC contract changes, or startup-gate impact explicitly since they cross process
  boundaries.
- **参考实现** — how competitors solve this, when relevant; consult the `competitors` skill rather
  than guessing.
- **范围 / 非目标** — what is explicitly out, especially the tempting adjacent work.
- **验收标准** — checkable statements of done; cover the core path plus the edge cases that
  motivated the issue. Include the behavior-level regression expectation from the `unit-testing` or
  `e2e-testing` skill.
- **Acceptance 方案** — keep this separate from the definition of done. Describe the isolated
  macOS Electron path, fixture or failure injection, expected observable result, and evidence
  needed for human review. Prefer screenshots for settled UI and GIF/video for behavior over time.
  Use DOM, structured logs, or text evidence only when the claim cannot be shown faithfully in the UI.
  Give every Go-owned check a stable id, and explain a non-visual check instead of fabricating
  desktop evidence.

`验收标准` defines what must be true. `Acceptance 方案` defines how the final reviewer will see or
otherwise verify that truth. Do not replace either section with the other.

## Refactor parity contract

Treat an issue as a refactor when it replaces, reorganizes, or reimplements an existing product or
architecture path while intending to preserve its nearest user-visible behavior. This includes
process/package/protocol ownership moves with no direct UI change; a label or proposed commit type
does not override the behavior-preservation requirement.

Every refactor issue must put these exact fields in `Acceptance 方案`:

- **证据模式** — `视觉` or `非视觉`.
- **最近用户可见行为** — name the closest observable behavior, including for architecture-only work.
- **保留行为** — enumerate the old product behaviors that must survive; proving only that the new
  architecture or UI exists is insufficient.
- **前后基线** — name the surfaces/states or structured receipts captured before the refactor and
  replayed after it. “对比截图” or a new-head-only screenshot is not a plan.
- **固定环境** — visual parity uses the same Project/fixture, persisted state, theme, window size,
  and viewport. Non-visual parity freezes the Project/fixture, persisted state, configuration, and
  app version, and explicitly marks irrelevant desktop dimensions.
- **交互重放** — enumerate applicable click, double-click, keyboard, Refresh, Retry, navigation,
  restart, and state-restoration actions. Non-visual work enumerates its equivalent API/CLI and
  failure-injection sequence. If no interaction applies, use `不适用：<reason>` or
  `not applicable: <reason>`; bare `N/A` is invalid.
- **时序证据** — use GIF/video for visible order over time and structured logs/event receipts when
  UI cannot faithfully show the claim. Settled screenshots do not replace sequence evidence. If
  the behavior has no temporal claim, use the same explicit not-applicable form with a reason.
- **Intentional differences / 非目标** — state every allowed observable difference. Any other
  observable difference is a regression and blocks Acceptance.

Architecture refactors may use `非视觉` structured before/after receipts, but CI, unit tests, a
successful build, or “the new UI is visible” never substitute for parity evidence. Refactor issues
must be created through the wrapper below, not a separate raw `gh issue create`; it freezes the
validated content and passes that exact snapshot to GitHub:

```bash
bun run .agents/skills/file-issue/scripts/create-refactor-issue.ts \
  --repo tjx666/caxri --title "$title" --body-file "$body_file" \
  --label enhancement --label skill --label acceptance --label P2 --label M
```

Use `validate-refactor-acceptance.ts --body-file "$body_file"` only for draft-only checks that do
not create an issue.

Code references (`path:line`) are welcome when they anchor the diagnosis or design — but keep them
to load-bearing ones; broad file inventories go stale.

## Mechanics

- Write the title, section headings, body prose, and follow-up issue comments in Simplified
  Chinese. Keep code, identifiers, paths, commands, enum values, and quoted upstream errors in
  English. This applies to every issue comment, not only comments created during filing.
  Contributor issue tracking lives in GitHub issues. Do not file repository work in Linear; the
  product's Project Status view may still read Linear references from a GitHub PR body.
- Never pass the body inline with `--body` and `\n` escapes — that ships literal `\n` into the
  issue. Write the body to a temp file and use `gh issue create --body-file`, or a real heredoc.
- For a refactor issue, use `create-refactor-issue.ts`; do not split validation and creation into
  separate commands.
- Link related issues and PRs with `#NN` references; if the issue is spun out of another one, name
  it in the 问题 section. Do not close or edit the parent.

## Labels

Fetch the live repository labels before drafting instead of assuming the catalog is unchanged:

```bash
gh label list --repo tjx666/caxri --limit 200 --json name,description,color
```

Apply exactly one type label:

- `bug` — existing behavior is incorrect.
- `enhancement` — new or improved behavior.
- `documentation` — documentation is the primary deliverable.
- `question` — a decision or investigation is the primary deliverable.

Then apply every directly relevant scope label, normally one to three:

| Label            | Use when the issue primarily changes                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `skill`          | Repository skills, agent workflows, harnesses, or their automation               |
| `unit-testing`   | Vitest unit/integration infrastructure or test-suite architecture                |
| `e2e-testing`    | Playwright Electron E2E infrastructure, fixtures, reliability, or suite workflow |
| `terminal`       | Terminal UI, xterm behavior, PTY lifecycle, or Terminal process integration      |
| `editor`         | Editor tabs, Monaco behavior, editing, save, diff, or in-file search             |
| `files-explorer` | Files inspector, tree navigation, file search, or file operations                |
| `git`            | Repository discovery, worktrees, status, history, diff, or Git operations        |
| `agent`          | Agent provider discovery, launch, lifecycle, identity, state, or integration     |
| `acceptance`     | Acceptance planning, evidence, fixtures, publication, or decision workflow       |
| `ci`             | GitHub Actions, CI gates, caching, runner behavior, duration, or cost            |

Do not apply `unit-testing` or `e2e-testing` merely because a product change requires regression
coverage. Apply them only when the testing system itself is part of the issue scope. Likewise, omit
a surface label when that surface is only incidental evidence.

Then apply exactly one priority label — `P0`, `P1`, or `P2` — chosen by the rules under
[Priority](#priority-assess-never-default). The label is what the owner sees on the issue list, so
an issue without one is a filing defect; the Project `Priority` field mirrors the same value.

Finally apply exactly one effort label — `XS`, `S`, `M`, `L`, or `XL` — assessed by the rules under
[Size](#size-agent-native-complexity). It carries the same value as the Project `Size` field, for
the same reason priority is recorded twice: the owner triages from the issue list, where Project
fields are not visible. An issue without an effort label is a filing defect.

Use only labels returned by the live query. Creating or changing repository labels requires a
separate explicit request; do not silently invent one during issue filing. Pass multiple labels
with repeated `--label` flags and verify the complete label set after creation.

## Project tracking

The Caxri project (<https://github.com/users/tjx666/projects/2>) is the owner's only work queue, so
an issue that is not on it is invisible. **Every** issue this skill creates is added to it — no
exceptions for small, obvious, or follow-up issues — and its fields are set explicitly:

```bash
gh project item-add 2 --owner tjx666 --url "$issue_url"
gh project item-edit 2 --owner tjx666 --url "$issue_url" --field Priority --value "<P0 Critical | P1 High | P2 Normal, matching the label>"
gh project item-edit 2 --owner tjx666 --url "$issue_url" --field Size --value "<assessed>"
gh project item-edit 2 --owner tjx666 --url "$issue_url" --field Status --value "Next"
```

- Do not assign the sole maintainer or invent a milestone merely to fill metadata.
- If a Project mutation fails, retry it once. Keep the successfully created issue, report the
  tracking failure, and never delete or recreate the issue to recover.
- Fetch the Project item once and verify its URL, Status, Priority, and Size before reporting
  success.

### Status lifecycle — keep it current, and honor `Backlog`

`Status` is how the owner sees what is happening without asking, so it is updated as the work
moves, not only at filing time. The options are `Backlog`, `Next`, `In Progress`, `Blocked`, and
`Done`.

| Moment                                               | Status        |
| ---------------------------------------------------- | ------------- |
| Filed, not started                                   | `Next`        |
| Implementation or verification actually begins       | `In Progress` |
| Waiting on a decision, an upstream fix, or the owner | `Blocked`     |
| The PR that resolves it is merged                    | `Done`        |

Use `In Progress` instead of `Next` only when implementation or verification is already underway.
When work starts later, flip it in the same turn you start — before writing code, not after. Set
`Done` only once the PR is merged; a PR that is merely open leaves the issue `In Progress`.

**`Backlog` means the owner does not want this done yet.** Never start work on a `Backlog` issue,
even when it is routed to you — including through the `go` skill's issue queue, which does not
filter by Status. Skip it and say why. The only thing that overrides this is the owner explicitly
asking for that issue by name in the current conversation; a general "clear the queue" does not.

### Priority (assess, never default)

Assess every issue explicitly against user impact; filing with an unconsidered default is a
process defect. State the chosen value and its one-line rationale in the filing report. The
priority is recorded twice with the same value: the `P0` / `P1` / `P2` label on the issue (visible
on the issue list) and the Project `Priority` field (`P0 Critical` / `P1 High` / `P2 Normal`).
`P3 Low` is retired; do not set it.

Walk the rules top-down and stop at the first match; any one condition in a row is enough.

- `P0` — fix before any other work. Loses or corrupts user data or Project files; exposes source,
  Terminal output, transcripts, credentials, or secrets across a privacy boundary; crashes or hangs
  the app, Server Core, or a Terminal; a core workflow (open a Project, run a Terminal or Agent,
  save a file) is unusable with no workaround; `main` cannot be built or released.
- `P1` — next up; do not start a `P2` over it. A primary workflow is materially degraded or
  produces wrong results on a daily path, with or without a workaround; the app visibly violates a
  setting or an explicit user choice; a permission or authority boundary is applied incorrectly; a
  CI or Acceptance gate fails intermittently; the owner asked for it soon.
- `P2` — pick up in queue order. Everything else that is worth doing: enhancements, polish,
  accessibility gaps with a workaround, observability and performance debt without a user-visible
  symptom, investigations and `question` issues, refactors, and deferrable follow-ups.

Tie-breakers:

- Judge by the worst realistic consequence on a user's daily path, not by the size of the fix.
- Frequency lowers nothing below the row it matches, but a condition that only appears with an
  unusual setup (two builds on one machine, a slow network mount) drops one row unless it breaks
  data, privacy, or a gate.
- A `bug` is not automatically `P1`; a `question` or `enhancement` is not automatically `P2`.
- When two rows seem to apply, take the higher one and say why in the filing report.

### Size (agent-native complexity)

Estimate in agent-native terms — ambiguity, architectural reach, ownership boundaries crossed,
validation cost, desktop/CI constraints, expected agent iterations — never manual coding time.
State the chosen value and its dominant cost driver in the filing report. Like priority, the size is
recorded twice with the same value: the `XS` / `S` / `M` / `L` / `XL` label on the issue and the
Project `Size` field. Assess it explicitly; filing with an unconsidered default is a process defect.

- `XS` — one obvious local change, trivial validation.
- `S` — a few files inside one owning surface; standard unit-test validation.
- `M` — crosses one boundary (schema migration, IPC contract, new UI surface) or needs E2E/desktop
  validation.
- `L` — crosses several boundaries or process layers, needs new interaction/design work plus
  multi-surface validation.
- `XL` — architectural: new subsystem, protocol change with wide fan-out, or multi-session
  delivery; consider splitting before filing.

## Filing behavior

Treat explicit invocation as execution authorization. When the user invokes `$file-issue` or asks
to file, create, or 提 an issue, draft it internally and file it immediately. Do not present a
preview or ask for confirmation first. Reply with the verified issue link and a concise summary of
what was filed.

Stop before creating only when the user explicitly asks for a draft, preview, or review, or when a
missing decision would materially change the issue. In draft-only mode, present the title, label,
and full body without creating anything.

After creation, fetch the issue and Project item once to verify the title, body, complete label
set, Status, and Priority rather than treating command exit statuses as the complete outcome.

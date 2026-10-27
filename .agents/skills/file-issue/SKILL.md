---
name: file-issue
description: 'Draft and directly file a well-formed GitHub issue for this repository, add it to the owner Caxri project, and keep its Status current as the work moves. Explicit invocation authorizes creation without a preview or confirmation. Use whenever creating an issue with gh (a bug report, an enhancement, or a follow-up task spun out of the current conversation), when the user asks to 提 issue / file an issue, or when starting, blocking, or finishing work tracked by an existing issue.'
---

# File Issue

Turn a bug, an idea, or a conclusion from the current conversation into a GitHub issue on this
repository. The issue must be self-contained: a fresh agent (or the user three weeks later) should
be able to pick it up without this conversation's context.

## Title

- Simplified Chinese, outcome-oriented, and ≤ 70 characters: “移除遮挡 Terminal 的恢复浮层”, not
  “Bug：浮层有问题” or “正在修复浮层”.
- No `[Bug]` / `feat:` prefixes: labels carry the classification.
- Use the repo's domain vocabulary with its capitalization: Project, Session, Terminal, Agent,
  Runtime, Renderer.

## Body structure

Write naturally under these sections. Bugs and enhancements emphasize different halves. Keep
`UX 设计` and `Acceptance 方案` in every issue; when the work has no direct UI or interaction
change, state that explicitly instead of inventing a visual claim.

- **问题**: every issue starts here. For a bug: observed behavior, expected behavior, and
  reproduction steps or the triggering condition. For an enhancement: the friction or gap, from
  the user's perspective.
- **诊断** (bug): root cause if known, citing the load-bearing code as
  `apps/desktop/src/main/index.ts:42` or symbol names. State clearly when the cause is a hypothesis,
  not confirmed.
- **目标** (enhancement): the end state in one or two sentences: what works afterwards that
  doesn't today.
- **UX 设计**: describe the user scenario, entry point, interaction flow, visible states, copy,
  keyboard behavior, and accessibility expectations affected by the issue. For non-UI architecture
  work, write `不涉及直接 UI 变化` and name the nearest user-visible outcome or explain why none
  exists.
- **方案 / 修复方案**: the approach, numbered when there are ordered steps. Mention schema
  migrations, IPC contract changes, or startup-gate impact explicitly since they cross process
  boundaries.
- **参考实现**: how competitors solve this, when relevant; consult the `competitors` skill rather
  than guessing.
- **范围 / 非目标**: what is explicitly out, especially the tempting adjacent work.
- **验收标准**: checkable statements of done; cover the core path plus the edge cases that
  motivated the issue. Include the behavior-level regression expectation from the `unit-testing` or
  `e2e-testing` skill.
- **Acceptance 方案**: keep this separate from the definition of done. Describe the isolated
  macOS Electron path, fixture or failure injection, expected observable result, and evidence
  needed for human review. Prefer screenshots for settled UI and GIF/video for behavior over time.
  Use DOM, structured logs, or text evidence only when the claim cannot be shown faithfully in the UI.
  Give every check a stable id, and explain a non-visual check instead of fabricating
  desktop evidence.

`验收标准` defines what must be true. `Acceptance 方案` defines how the final reviewer will see or
otherwise verify that truth. Do not replace either section with the other.

## Refactor parity contract

Treat an issue as a refactor when it replaces, reorganizes, or reimplements an existing product or
architecture path while intending to preserve its nearest user-visible behavior. This includes
process/package/protocol ownership moves with no direct UI change; a label or proposed commit type
does not override the behavior-preservation requirement.

Every refactor issue must put these exact fields in `Acceptance 方案`. The validator reads each
field only from a single top-level bullet line, `- **<field>**: <value>`, so keep the whole value on
that line: wrapped continuation lines and nested sub-bullets are ignored, and a field whose
same-line value is shorter than 8 characters counts as missing. For example,
`- **前后基线**: 重构前在 v0.0.129 采集 Session 列表截图，重构后在同一 fixture 重放并对比`.

- **证据模式**: exactly `视觉` or `非视觉`, with nothing else on the line; put the reasoning in
  another field.
- **最近用户可见行为**: name the closest observable behavior, including for architecture-only work.
- **保留行为**: enumerate the old product behaviors that must survive; proving only that the new
  architecture or UI exists is insufficient.
- **前后基线**: name the surfaces/states or structured receipts captured before the refactor and
  replayed after it, using the literal words `重构前` and `重构后` (or `before` and `after`).
  “对比截图” or a new-head-only screenshot is not a plan.
- **固定环境**: say `同一` or `固定` explicitly. Visual parity uses the same Project/fixture,
  persisted state, theme, window size, and viewport. Non-visual parity freezes the Project/fixture,
  persisted state, configuration, and app version, and states that theme, window size, and viewport
  are `不适用`.
- **交互重放**: enumerate applicable click, double-click, keyboard, Refresh, Retry, navigation,
  restart, and state-restoration actions. Non-visual work enumerates its equivalent API/CLI and
  failure-injection sequence. If no interaction applies, use `不适用：<reason>` or
  `not applicable: <reason>`; bare `N/A` is invalid.
- **时序证据**: use GIF/video for visible order over time and structured logs/event receipts when
  UI cannot faithfully show the claim. Settled screenshots do not replace sequence evidence. If
  the behavior has no temporal claim, use the same explicit not-applicable form with a reason.
- **Intentional differences / 非目标**: state every allowed observable difference. Any other
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

Code references (`path:line`) are welcome when they anchor the diagnosis or design, but keep them
to load-bearing ones; broad file inventories go stale.

## Mechanics

- Search open and closed issues for the same symptom before creating one, even when the filing is
  exempt from the independent review below: `gh issue list --repo tjx666/caxri --state all
--search "<symptom keywords>" --limit 10`, once in Chinese and once with the method or file name.
  Reuse a match (comment, reopen, or move its Status) instead of filing a duplicate. A user-reported
  Session switch delay was filed as a new issue while an open issue already tracked it.
- Before creating, editing, or commenting on an issue, Call the Skill tool with
  "oss-confidentiality" and review the title, body, comment, links, and attached artifacts as public
  content. Describe a removed private value generically instead of repeating it in the issue.
- For every embedded, attached, or linked image, the acting Agent must complete
  `oss-confidentiality`'s original-and-final visual review. Do not create, edit, or comment until
  each image is confirmed safe or removed; never hand routine screenshot review to the maintainer.
- Write the title, section headings, body prose, and follow-up issue comments in Simplified
  Chinese. Keep code, identifiers, paths, commands, enum values, and quoted upstream errors in
  English. This applies to every issue comment, not only comments created during filing.
  Contributor issue tracking lives in GitHub issues. Do not file repository work in Linear; the
  product's Project Status view may still read Linear references from a GitHub PR body.
- Never pass the body inline with `--body` and `\n` escapes: that ships literal `\n` into the
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

Labels are read as five independent axes: type, surface, area, priority, effort. An issue is fully
labeled when it carries one type, at least one area, one priority, one effort, and a surface
whenever the work belongs to a single app.

### Type: exactly one

- `bug`: existing behavior is incorrect.
- `enhancement`: new or improved behavior.
- `documentation`: documentation is the primary deliverable.
- `question`: a decision or investigation is the primary deliverable.

### Surface: which app, zero or one

This repository ships four deliverables under `apps/`. The surface label answers “which app do I
have to build and run to see this?”. The first thing triage needs, and the one thing an area label
never tells you, because `session`, `diagnostics`, or `agent` each span more than one app.

| Label     | Owning code                                                                           |
| --------- | ------------------------------------------------------------------------------------- |
| `desktop` | `apps/desktop`: main process, preload, renderer shell, windows, menus, OS integration |
| `server`  | `apps/server`: domain services and the Core process every client talks to             |
| `mobile`  | `apps/mobile` + `packages/mobile-transport`: mobile client, pairing, gateway          |
| `cli`     | `apps/cli`: `caxri` commands                                                          |

Apply one when the issue lives inside a single app. Omit it when the work is genuinely shared (a
`packages/*` change, a protocol contract, repository tooling) rather than guessing, since a wrong
surface sends triage to the wrong build. Needing two surfaces usually means the issue crosses a
process boundary: say so in 方案, and consider whether it should be split before filing.

### Area: what it changes, one to three

| Label            | Use when the issue primarily changes                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `terminal`       | Terminal UI, xterm behavior, PTY lifecycle, or Terminal process integration      |
| `editor`         | Editor tabs, Monaco behavior, editing, save, diff, or in-file search             |
| `files-explorer` | Files inspector, file tree navigation, file search, or file operations           |
| `tree-view`      | Extension-contributed tree views and the view container tree runtime             |
| `session`        | Session lifecycle: creation, switching, restore, auto-naming, or persistence     |
| `git`            | Repository discovery, worktrees, status, history, diff, or Git operations        |
| `settings`       | Settings UI and configuration read, write, watch, or validation                  |
| `theme`          | Theming, semantic color tokens, or theme import/export                           |
| `a11y`           | Keyboard navigation, focus order, or screen reader support                       |
| `agent`          | Agent work spanning or sitting outside the three specific agent areas below      |
| `agent-provider` | Claude / Codex / Grok discovery, launch, identity, or metadata                   |
| `agent-hook`     | Lifecycle hook installation, authorization, phases, or hook receipts             |
| `agent-dispatch` | Dispatch and delegation: routing, presets, depth, or dispatch receipts           |
| `protocol`       | Wire protocol and IPC contracts between desktop, server, and mobile              |
| `extension-api`  | Extension API surface, declared capabilities, or Extension Host behavior         |
| `db`             | SQLite schema, drizzle migrations, or persistence integrity                      |
| `diagnostics`    | Structured logging, diagnostics export, observability, or log query              |
| `performance`    | Render counts, re-render budgets, latency, or resource usage                     |
| `skill`          | Repository skills, agent workflows, harnesses, or their automation               |
| `acceptance`     | Acceptance planning, evidence, fixtures, publication, or decision workflow       |
| `ci`             | GitHub Actions, CI gates, caching, runner behavior, duration, or cost            |
| `unit-testing`   | Vitest unit/integration infrastructure or test-suite architecture                |
| `e2e-testing`    | Playwright Electron E2E infrastructure, fixtures, reliability, or suite workflow |
| `deps`           | Dependency versions, pins, overrides, or patches                                 |

Prefer the specific agent area over bare `agent`; reach for `agent` alone only when the issue truly
spans provider, hook, and dispatch, or belongs to none of them.

`files-explorer` owns the Files inspector; `tree-view` owns the generic tree runtime an extension
contributes to under `view-containers`. How the Files tree renders its rows is `files-explorer`;
what an extension can put in a tree is `tree-view`.

Do not apply `unit-testing` or `e2e-testing` merely because a product change requires regression
coverage. Apply them only when the testing system itself is part of the issue scope. Likewise, omit
an area when it is only incidental evidence: `performance` belongs on an issue whose deliverable is
the speedup, not on every issue that happens to mention a render count.

### Priority and effort

Apply exactly one priority label (`P0`, `P1`, or `P2`) chosen by the rules under
[Priority](#priority-assess-never-default). The label is what the owner sees on the issue list, so
an issue without one is a filing defect; the Project `Priority` field mirrors the same value.

Finally apply exactly one effort label (`XS`, `S`, `M`, `L`, or `XL`) assessed by the rules under
[Size](#size-agent-native-complexity). It carries the same value as the Project `Size` field, for
the same reason priority is recorded twice: the owner triages from the issue list, where Project
fields are not visible. An issue without an effort label is a filing defect.

Use only labels returned by the live query. Creating or changing repository labels requires a
separate explicit request; do not silently invent one during issue filing. Pass multiple labels
with repeated `--label` flags and verify the complete label set after creation.

## Project tracking

The Caxri project (<https://github.com/users/tjx666/projects/2>) is the owner's only work queue, so
an issue that is not on it is invisible. **Every** issue this skill creates is added to it: no
exceptions for small, obvious, or follow-up issues, and its fields are set explicitly:

```bash
bun run .agents/skills/file-issue/scripts/track-project-item.ts --url "$issue_url" \
  --status "Next" --priority "<P0 Critical | P1 High | P2 Normal, matching the label>" --size "<assessed>"
```

The script adds the item when it is missing, sets every given field in one mutation, and prints the
Status, Priority, and Size read back from GitHub: that output is the verification. Use it for every
later Status change too (`--url "$issue_url" --status "In Progress"`). Do not use
`gh project item-edit --url --field` or `gh project item-list`: each re-reads the Project's whole
field catalog or every item's field values and costs ~100 or ~800 points of the account-wide
GitHub GraphQL budget, which the owner's shell, every Agent, and the Caxri app share; one batch of
13 issues filed that way exhausted the hourly budget. The script costs ~5 points per issue.

- Do not assign the sole maintainer or invent a milestone merely to fill metadata.
- If a Project mutation fails, retry it once. Keep the successfully created issue, report the
  tracking failure, and never delete or recreate the issue to recover.
- Verify the URL and the printed Status, Priority, and Size before reporting success.

### Status lifecycle: keep it current, and honor `Backlog`

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
When work starts later, flip it in the same turn you start, before writing code, not after. Set
`Done` only once the PR is merged; a PR that is merely open leaves the issue `In Progress`.

**`Backlog` means the owner does not want this done yet.** Never start work on a `Backlog` issue,
even when it is routed to you. Skip it and say why. The only thing that overrides this is the owner explicitly
asking for that issue by name in the current conversation; a general "clear the queue" does not.

### Priority (assess, never default)

Assess every issue explicitly against user impact; filing with an unconsidered default is a
process defect. State the chosen value and its one-line rationale in the filing report. The
priority is recorded twice with the same value: the `P0` / `P1` / `P2` label on the issue (visible
on the issue list) and the Project `Priority` field (`P0 Critical` / `P1 High` / `P2 Normal`).
`P3 Low` is retired; do not set it.

Walk the rules top-down and stop at the first match; any one condition in a row is enough.

- `P0`: fix before any other work. Loses or corrupts user data or Project files; exposes source,
  Terminal output, transcripts, credentials, or secrets across a privacy boundary; crashes or hangs
  the app, Server Core, or a Terminal; a core workflow (open a Project, run a Terminal or Agent,
  save a file) is unusable with no workaround; `main` cannot be built or released.
- `P1`: next up; do not start a `P2` over it. A primary workflow is materially degraded or
  produces wrong results on a daily path, with or without a workaround; the app visibly violates a
  setting or an explicit user choice; a permission or authority boundary is applied incorrectly; a
  CI or Acceptance gate fails intermittently; the owner asked for it soon.
- `P2`: pick up in queue order. Everything else that is worth doing: enhancements, polish,
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

Estimate in agent-native terms (ambiguity, architectural reach, ownership boundaries crossed,
validation cost, desktop/CI constraints, expected agent iterations), never manual coding time.
State the chosen value and its dominant cost driver in the filing report. Like priority, the size is
recorded twice with the same value: the `XS` / `S` / `M` / `L` / `XL` label on the issue and the
Project `Size` field. Assess it explicitly; filing with an unconsidered default is a process defect.

- `XS`: one obvious local change, trivial validation.
- `S`: a few files inside one owning surface; standard unit-test validation.
- `M`: crosses one boundary (schema migration, IPC contract, new UI surface) or needs E2E/desktop
  validation.
- `L`: crosses several boundaries or process layers, needs new interaction/design work plus
  multi-surface validation.
- `XL`: architectural: new subsystem, protocol change with wide fan-out, or multi-session
  delivery; consider splitting before filing.

## Filing behavior

Treat explicit invocation as execution authorization. When the user invokes `$file-issue` or asks
to file, create, or 提 an issue, draft it internally and file it immediately. Do not present a
preview or ask for confirmation first. Reply with the verified issue link and a concise summary of
what was filed.

Stop before creating only when the user explicitly asks for a draft, preview, or review, or when a
missing decision would materially change the issue. In draft-only mode, present the title, label,
and full body without creating anything.

Never ask the user whether something is worth filing. "Should I file an issue for this?" hands back
a judgment the agent is better placed to make: it has the evidence in front of it and the user does
not, and it stalls delivery on a round trip. Run the review below instead, and act on its verdict.

After creation, fetch the issue and Project item once to verify the title, body, complete label
set, Status, and Priority rather than treating command exit statuses as the complete outcome.

## Independent review before filing

Every filing decision (one issue or a batch) is reviewed by a second opinion first: a subagent, or
another harness through `dianjiang`. The gate covers anything the agent concluded on its own: a bug
it believes it found, a follow-up it wants to leave behind, an enhancement it thought of. It does
not cover an issue that merely records work the user explicitly directed, where there is no
judgment to test; file that one directly after the duplicate search in [Mechanics](#mechanics).

The reviewer is separate from the agent that found the problem
because the finder is the worst judge of its own find: it already believes the diagnosis, and a
plausible story about a symptom it just hit reads as confirmed to it in a way it does not to anyone
else. Filing it anyway costs the owner a triage pass on something that turns out to be a duplicate,
a local mistake, or already-documented behavior.

Hand the reviewer the drafted finding, the repository path, and read-only scope: no edits, no issue
creation, no remote mutation. Ask it to verify each load-bearing claim against the code rather than
against the draft, to search for an existing issue that already covers it, and to return a verdict
in Simplified Chinese covering whether to file, a per-claim CONFIRMED / PARTLY / REFUTED with
`path:line` evidence, any duplicate, a corrected framing if the finding is real but aimed at the
wrong owner, and a suggested priority and size.

Then adjudicate against current repository state: the verdict is evidence, not a decision:

- **Confirmed and not a duplicate** → file it, folding in the reviewer's corrections to framing,
  priority, and size.
- **Refuted, already covered, or already-documented behavior** → do not file. Say so in the reply,
  naming the duplicate or the documentation that settles it.
- **Real but framed wrong** → file the corrected issue, not the draft.

Report the review's effect in the final reply: what it confirmed, what it changed, what it killed,
so the user can see the filing decision was tested rather than asserted. A review that agreed with
everything is worth one clause, not a section.

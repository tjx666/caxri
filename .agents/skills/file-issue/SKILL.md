---
name: file-issue
description: 'Draft and directly file a well-formed GitHub issue for this repository. Explicit invocation authorizes creation without a preview or confirmation. Use whenever creating an issue with gh — a bug report, an enhancement, or a follow-up task spun out of the current conversation — or when the user asks to 提 issue / file an issue.'
---

# File Issue

Turn a bug, an idea, or a conclusion from the current conversation into a GitHub issue on this repository. The issue must be self-contained: a fresh agent (or the user three weeks later) should be able to pick it up without this conversation's context.

## Title

- Simplified Chinese, outcome-oriented, and ≤ 70 characters: “移除遮挡 Terminal 的恢复浮层”, not “Bug：浮层有问题” or “正在修复浮层”.
- No `[Bug]` / `feat:` prefixes — labels carry the classification.
- Use the repo's domain vocabulary with its capitalization: Project, Session, Terminal, Agent, Runtime, Renderer.

## Body structure

Write naturally under these sections. Bugs and enhancements emphasize different halves. Keep
`UX 设计` and `Acceptance 方案` in every issue; when the work has no direct UI or interaction
change, state that explicitly instead of inventing a visual claim.

- **问题** — every issue starts here. For a bug: observed behavior, expected behavior, and reproduction steps or the triggering condition. For an enhancement: the friction or gap, from the user's perspective.
- **诊断** (bug) — root cause if known, citing the load-bearing code as `path/to/file.ts:42` or symbol names. State clearly when the cause is a hypothesis, not confirmed.
- **目标** (enhancement) — the end state in one or two sentences: what works afterwards that doesn't today.
- **UX 设计** — describe the user scenario, entry point, interaction flow, visible states, copy,
  keyboard behavior, and accessibility expectations affected by the issue. For non-UI architecture
  work, write `不涉及直接 UI 变化` and name the nearest user-visible outcome or explain why none
  exists.
- **方案 / 修复方案** — the approach, numbered when there are ordered steps. Mention schema migrations, IPC contract changes, or startup-gate impact explicitly since they cross process boundaries.
- **参考实现** — how competitors solve this, when relevant; consult the `competitors` skill rather than guessing.
- **范围 / 非目标** — what is explicitly out, especially the tempting adjacent work.
- **验收标准** — checkable statements of done; cover the core path plus the edge cases that motivated the issue. Include the regression-test expectation (behavior-level, per the testing workflow in AGENTS.md).
- **Acceptance 方案** — keep this separate from the definition of done. Describe the isolated
  macOS Electron path, fixture or failure injection, expected observable result, and evidence needed
  for human review. Prefer screenshots for settled UI and GIF/video for behavior over time. Use DOM,
  structured logs, or text evidence only when the claim cannot be shown faithfully in the UI. Give
  every Go-owned check a stable id, and explain a non-visual check instead of fabricating desktop
  evidence.

`验收标准` defines what must be true. `Acceptance 方案` defines how the final reviewer will see or
otherwise verify that truth. Do not replace either section with the other.

Code references (`path:line`) are welcome when they anchor the diagnosis or design — but keep them to load-bearing ones; broad file inventories go stale.

## Mechanics

- Write the title, section headings, body prose, and follow-up issue comments in Simplified Chinese.
  Keep code, identifiers, paths, commands, enum values, and quoted upstream errors in English.
  This applies to every issue comment, not only comments created during filing.
- Never pass the body inline with `--body` and `\n` escapes — that ships literal `\n` into the issue. Write the body to a temp file and use `gh issue create --body-file`, or a real heredoc.
- Apply one label from the repo's existing vocabulary (`bug`, `enhancement`, `documentation`, `question`); don't invent new labels without asking.
- Link related issues and PRs with `#NN` references; if the issue is spun out of another one, name it in the 问题 section. Do not close or edit the parent.

## Project tracking

After creating the issue, always add it to the owner's Caxri project and set its fields explicitly:

```bash
gh project item-add 2 --owner tjx666 --url "$issue_url"
gh project item-edit 2 --owner tjx666 --url "$issue_url" --field Priority --value "P2 Normal"
gh project item-edit 2 --owner tjx666 --url "$issue_url" --field Status --value "Backlog"
```

- Use `In Progress` instead of `Backlog` only when implementation or verification is already underway.
- Raise priority to `P1 High` or `P0 Critical` only when the issue body establishes concrete user impact; use `P3 Low` for explicitly deferrable work.
- Do not assign the sole maintainer or invent a milestone merely to fill metadata.
- If a Project mutation fails, retry it once. Keep the successfully created issue, report the tracking failure, and never delete or recreate the issue to recover.
- Fetch the Project item once and verify its URL, Status, and Priority before reporting success.

## Filing behavior

Treat explicit invocation as execution authorization. When the user invokes `$file-issue` or asks to file, create, or 提 an issue, draft it internally and file it immediately. Do not present a preview or ask for confirmation first. Reply with the verified issue link and a concise summary of what was filed.

Stop before creating only when the user explicitly asks for a draft, preview, or review, or when a missing decision would materially change the issue. In draft-only mode, present the title, label, and full body without creating anything.

After creation, fetch the issue and Project item once to verify the title, body, label, Status, and Priority rather than treating command exit statuses as the complete outcome.

---
name: audit-ux
description: Audit Caxri's user-visible experience with context-isolated subagents, real macOS Electron screenshots, a CDP walkthrough of the installed production app, production log analysis, and per-scenario render counts (first paint, Session/Panel/tab switches, Refresh clicks, tree expansion), then synthesize a prioritized optimization list. Always takes an explicit scope argument, such as a time window ("last 2 days"), a commit count or rev-range ("last 15 commits", "HEAD~5..HEAD"), or a UI surface ("settings dialog", "terminal", "file tree"). Use when asked to review UX changes in recent commits, audit a page or feature's interaction quality, check a surface for wasted re-renders, find UX optimization points, or 优化/审查 a UI surface; also use for the UX pass after a large feature lands. Not a bug hunt and not a code-correctness review; use deep-review for merge readiness.
argument-hint: '<last N days | last N commits | <rev-range> | <surface>> [--no-desktop] [--no-production] [--fix]'
---

# Audit Caxri UX

Find experience problems and polish opportunities in a bounded scope, with every verdict backed by
evidence from a layer that can actually see it. The audit produces a prioritized optimization list;
implementation happens only in the separate fix mode below.

The benchmark is `DESIGN.md` (tokens, motion system, confirmations, status-bar redlines,
plain-language settings) plus macOS desktop conventions. When judging a surface whose class
another product already solved (terminal links, copy-on-select, shortcut recorders), name the class
norm first: Call the Skill tool with "competitors" when the norm is unclear. Reading our own code
only polishes what exists; it is structurally blind to an affordance we never built.

## 1. Resolve the scope: required, never implied

Every run starts from the caller's scope argument. Refuse to guess: if no scope was given, ask for
one before spawning anything.

- **Time window** ("last 2 days"): `git log --since=... --pretty='%h %ad %s' --stat` to list
  commits and touched files.
- **Commit count / rev-range** ("last 15 commits", `HEAD~5..HEAD`): same, via `git log -n` or the
  range.
- **Surface** ("settings dialog", "terminal", "sidebar"): map the name to its feature directory
  under `apps/desktop/src/renderer/src/features/` (plus its Runtime/Main counterparts when the UX
  spans processes) and audit the current state, not a diff.

For commit scopes, keep only UX-relevant commits: renderer features, shared IPC that feeds UI,
UI-visible Runtime behavior (terminal restore, file operations). Drop pure test/CI/skill commits.
Then group what remains into **theme packages** by feature area (sidebar/session, settings/dialogs,
terminal, file tree, new surfaces...). One package = one subagent = one cohesive slice of the
product; 3–6 packages is typical. A surface scope is usually a single package plus the live
inspection.

## 2. Evidence layers: a verdict must come from a layer that can see it

- **Code layer**: interaction wiring, missing states, feedback gaps, a11y attributes, keyboard
  paths, copy quality, token usage. Evidence is `file:line`.
- **Desktop layer**: what actually renders: alignment, contrast, truncation, hover states, motion
  feel, whether an affordance is visible at all. Evidence is a screenshot the root agent has viewed
  with the Read tool.
- **Render layer**: how much work an interaction costs: first paint, switching a Session, a
  Panel, or a work tab, clicking Refresh, expanding the file tree. Evidence is a per-instance
  render-count table for a named scenario, from
  [references/render-layer.md](references/render-layer.md).
- **Production layer**: the installed `/Applications/Caxri.app` with the owner's real Projects,
  Sessions, and history: states no fixture reproduces (long Session lists, real Agent usage, many
  worktrees, stale data). Evidence is a screenshot taken over CDP on `9224` and viewed with the
  Read tool.
- **Log layer**: the production profile's `~/Library/Application Support/Caxri/logs/*.jsonl` over
  the scope window: `warn`/`error` events, failure classifications, slow or repeated `ipc.request`
  methods, restarts, reconnect loops. Evidence is the event name, count, time range, and
  `correlationId`, never message content.

Never tick a visual verdict off the code (a `underline: true` decoration may only render on hover:
the code layer cannot know), and never diagnose a missing state machine from a screenshot. A
screenshot cannot show that one click re-rendered eighty components, and reading a component cannot
tell you how often it actually ran; that is the render layer's job, and it is the only layer whose
findings the user feels as sluggishness rather than sees as a defect. When two layers disagree,
that disagreement is itself a finding; the root agent resolves it by reading the evidence together.

`--no-desktop` (or an unavailable desktop lease) skips the visual and render layers;
`--no-production` skips the production and log layers. The report must then mark every claim
those layers would have checked as code-inferred and unverified.

## 3. Dispatch subagents in one wave

Launch all reviewers, the one desktop agent, and the one production agent concurrently. Review
agents are read-only and need isolated context: give each a self-contained prompt, and do not leak another package's findings or
your own suspicions into it.

**Per-theme review agent**: the prompt must carry these elements, learned the hard way:

- Read `DESIGN.md` first; the audit measures against it.
- List the exact commits (for commit scope) or directories (for surface scope) in scope.
- "Use `git show` for the diffs, then read the **current state** of the touched files: judge the
  as-is UX, not the diff." Later commits routinely rework earlier ones.
- "Your goal is NOT bug hunting: find UX optimization opportunities": interaction friction,
  discoverability, feedback/affordance gaps, cross-surface inconsistency, keyboard access, a11y
  (focus, aria, contrast tokens), motion feel, empty/edge states, copy quality.
- Require prioritized raw findings (high/medium/low), each with title, `file:line`, what the
  current UX does, why it's suboptimal, and a concrete improvement.
- Require a "what the commits did well, keep" section. Strengths calibrate severity and become
  the don't-regress list; an audit with only gaps has drifted into a bug report.
- Read-only; no file modifications.

**Desktop agent**: exactly one, running the visual phase and the render phase **in sequence**. One
Electron window at a time is a hard constraint, not a preference: the visual phase needs a built
app under the repository-wide desktop lease, the render phase needs an unpackaged instance (a built
Renderer's component names are minified into noise), and two live instances fight over window
focus, so a screenshot taken while a second app is up can capture the wrong window.

The desktop and mobile agents run every command in the checkout the root session works in. When
the root has entered a task worktree (`EnterWorktree`), a subagent pointed at the primary checkout
has each Bash call refused by the worktree isolation, and both live layers come back empty.

Visual phase:

- Launch with the `debug` skill's
  `fake-agent-development-environment.ts <evidence temp dir> --provider claude --dev` (isolated
  profile, temp test root, fake Agents, the desktop lease through `switch-worktree dev`) and drive
  it with `drive-app.ts`; never a second Electron instance, never bypassing the lease. Acceptance's
  `start-electron.ts` needs a built bundle and a frozen report plan an audit does not have.
- Give it the concrete surface list derived from the scope (which dialogs to open, which menus to
  right-click, which settings tabs to scroll) rather than "look around".
- Evidence (screenshots, render tables, recordings) goes to one per-run directory outside `/tmp`,
  such as `~/.cache/caxri-ux-audit-<date>/<phase>/`, with paths reported per finding. A run spans
  hours and several agents; a `/tmp` evidence tree vanished mid-audit once. Agents never delete a
  directory they did not create.
- Surfaces that only appear in a state (the waiting popup, a pace alert, an image marker) need the
  fixture or trigger that produces the state named in the prompt; "the state never appeared" is a
  setup gap to fix, not a verdict.
- It stops the app and releases the lease before the render phase starts.

Render phase: follow [references/render-layer.md](references/render-layer.md), which owns the
arming flag, the collector, and the traps:

- Name the scenarios up front from the scope: always the first paint of the Workbench, plus the
  switches and refreshes the scope actually touches (Session switch, Panel or secondary-sidebar tab
  switch, work-tab switch, a view's Refresh button, file-tree expansion).
- Seed a representative fixture first (an empty Workbench renders almost nothing, so its counts
  prove nothing) and report the fixture shape, because counts only compare against the same shape.
- Require the raw per-instance table per scenario, and a stated expectation per scenario ("one
  Session switch should re-render the two Session cards and the tab strip"). A count without an
  expectation is not a finding. Sample at least one interaction you expect to be cheap; a scenario
  is judged against a measured baseline from the same run, not against a remembered number.
- Every render finding must name the avoidable cause: the prop, state, context, or hook that
  moved. Counts alone go into the report as observations, never into a fix batch.

**Production agent**: exactly one, running the production layer and then the log layer. It
drives the installed app the owner is using, so it may run beside the desktop agent: every call
targets `9224` through `bun run .agents/skills/debug/scripts/worktree-browser.ts --packaged`
(`eval`, `click`, `hover`, `screenshot`), never synthesized OS input or a focus change.

- Before the first mutation, write a restore point to `<evidence>/production/before.json`: the
  selected Project and Session, open Panel and secondary-sidebar tabs, work tabs, theme, and the
  full settings source (`settings.get`).
- Click through every surface in scope with the owner's real data: menus, dialogs, Settings tabs,
  hover cards, long lists, and the Sessions the scope's commits changed. Leave existing Sessions'
  content untouched: no sending, renaming, archiving, Mark as Done, or deleting. Opening one stamps
  its last visit and clears its unread mark, so open only Idle Sessions that are already read.
- Create at most one new Session per Agent type (Claude Code, Codex, Grok Build, Antigravity) in an
  existing Project when a surface needs a fresh one, opened in Chat, record each id, and send no
  prompt: a real Agent spends the owner's quota and writes a real transcript. Do not create a Shell
  Session; it has no confirmation-free removal.
- Clean up before the log layer: from the Renderer, call
  `window.caxri.request('session.discardIfEmpty', { sessionId })` for each created Session and
  require `discarded: true`. `session.delete` and `session.archive` need the `desktop` capability no
  CLI caller has, and the Renderer's `session.delete` opens Main's native confirmation, which hangs
  CDP. Restore every recorded value, then compare `app.bootstrap` and `settings.get` against
  `before.json` and report any difference or undiscarded Session as unrestored.
- Log layer: aggregate the production logs with bounded `jq` over `server-core.jsonl`,
  `desktop.jsonl`, `extension-host.jsonl`, and `terminal-host.jsonl` plus their rotated `.1`–`.3`
  generations (`ipc.request` lines carrying `principal`, by `method` with count, p95 `durationMs`
  and `queueMs`; `warn`/`error` by `event` and reason). Rotation can leave `server-core` short of
  the scope window: state the covered range. An Agent's `caxri logs query` lacks `diagnostics.read`.
  Each log finding names the user-visible symptom it implies or says it is unknown.
- Production screenshots carry the owner's real data: they stay in the local evidence directory
  and never go into an issue, PR, or other public artifact (`oss-confidentiality`).

**Mobile agent**: when the scope touches `apps/mobile`, one more agent runs the `acceptance`
skill's Android surface on the disposable emulator and captures every mobile surface in scope,
including offline, empty, and error states. A mobile visual verdict read off the code is
unverified: one audit's "hardcoded English Done" was rendered translated on the emulator.

Every live phase (visual, render, production, log, mobile) ends with an explicit "surfaces and
scenarios not verified" list; a silent gap reads as coverage. An item enters that list only after **two concrete methods** were tried, each recorded
with its command and failure output. "Automation cannot reach it" is the start of the work, not
the verdict. Try the existing mechanisms first:

- Native context menus: `e2e/support/native-context-menu.ts` reads and clicks the menu Main
  intercepted under E2E.
- Usage and pace states: the seeding in `e2e/agent-chat-plan-limits.e2e.ts`.
- Motion (frost, glide, fades): `screencapture -v` plus extracted frames, not a still.
- Agent behavior the fake fixture does not emit: the fixtures under `e2e/support/agent-*.ts`;
  failing that, the `debug` skill's fail-closed real-CLI procedure.
- Mobile states without a scenario: adb input, toggled emulator networking, or an ad hoc scenario
  beside `e2e/support/mobile-*-scenario.ts`.

## 4. Synthesize: the root agent's own work

Do not paste subagent output through. Merge, then:

1. **Deduplicate** across packages and cross-check the layers. Screenshot evidence upgrades or
   kills code-inferred visual claims; a render table upgrades or kills a code-inferred cost claim.
   Check a subagent's negative claim against the code before it explains a missed repro: "Chat
   never emits a waiting attention" was false (the Claude and Codex request paths emit one), and
   accepting it would have closed a user-reported bug as unreproducible.
2. **Prioritize** with this rubric:
   - **High: breaks trust or loses work**: silent clipboard clobbering, an error the user cannot
     see, a destructive action with no feedback, a state the UI cannot get out of. A render finding
     reaches High only when the interaction visibly stalls or drops input.
   - **Medium: dead-ends, misleads, or hides**: effort wasted before a blocker is revealed, color
     that contradicts its semantic token, an unexplained disabled control, a mode with no active
     indicator. Also: one interaction re-renders a surface it does not touch, or a hidden
     view's subtree re-renders on every unrelated update: invisible work the user pays for.
   - **Low: friction and polish**: awkward copy, magic-number layout coupling, missing empty-state
     affordances, inconsistent icon treatment. Also: a count above its expectation with a named but
     cheap cause.
3. **Decide routine product choices yourself** (thresholds, copy, naming, which of two reasonable
   treatments): state the chosen default with a one-line reason and put it in the fix batch. Resolve
   a code-versus-DESIGN.md conflict by choosing one side and updating the other. For example, the
   context meter's warning threshold or whether a reply's Copy stays visible is decided, not asked.
   Escalate only what `AGENTS.md` escalates: schema design, a large feature needing design,
   destructive or credential steps, and genuinely ambiguous requirements.
4. Keep DESIGN.md violations explicitly labeled as such: they outrank taste.
5. Discard render findings whose cause is a deliberate design decision the code documents. The
   known one: a Panel or secondary-sidebar container stays mounted after its first show
   (`apps/desktop/src/renderer/src/features/view-containers/view-container-surface.tsx`, the "stays
   mounted (hidden) once it has been shown" comment), so
   mounting once and never unmounting is intended: a hidden container that keeps _re-rendering_
   is still a finding.

## 5. Report

Final reply in the conversation language; code, paths, and UI strings stay English.

1. Which layers ran, the resolved scope (commit list or surface), the screenshot directory, and the
   render scenarios sampled with the fixture shape their counts describe, the production surfaces
   walked with the Sessions created and their cleanup result, and the log window read.
2. Findings by priority, each with `file:line`, screenshot path, and/or scenario counts, current
   behavior, why it falls short, and the concrete improvement. A render finding states the
   scenario, the observed and expected counts, and the named cause.
3. **Strengths worth keeping**: verified-working recent fixes and load-bearing good behavior, with
   evidence.
4. Surfaces/claims not verified, each with the two methods tried and their failure output.
5. Offer next steps (fix batch, GitHub issues) without starting them.

## 6. Fix mode: only on explicit request (`--fix` or a follow-up "优化下")

The audit itself is read-only. When the user asks for implementation:

- Regroup accepted findings into **file-disjoint work packages** by feature area; shared contracts
  under `packages/` belong to exactly one package. Launch packages concurrently only when their
  file sets cannot collide.
- Every implementation subagent gets the same rails: read `AGENTS.md` + `DESIGN.md`; English UI
  strings; tokens-only colors; do not commit; validate with `bun run check <files>` (add
  `--lint --test --type` for shared-contract changes) and focused
  `bunx vitest run --silent='passed-only' <files>`; never a full suite or E2E; extract logic into
  pure functions for tests instead of unit-testing components; stay inside the assigned file set
  even when the worktree carries unrelated dirty files.
- Before changing user-visible text, an accessible name, or a control, a subagent searches `e2e/`
  and `apps/**/__tests__/` for the old text, the control's identifiers, and static fragments of
  computed labels (`Chat` in `<Agent> Chat`). On a match it reports the `file:line` to the root and
  leaves that change unapplied; the root decides and owns the consumer updates and focused E2E
  (`pull-request` step 5). Dropping the `Chat` marker from Agent menu rows broke 13 specs this way.
- The root agent then **personally verifies**: read every diff, re-run one aggregate
  `bun run check <all changed files> --lint --test --type`, run `bun run knip` when renderer or
  shared files changed, and only then commit: one cohesive commit per package, excluding
  pre-existing unrelated worktree changes.
- Run the mobile emulator verification only after the mobile package is committed, from the same
  worktree's clean HEAD: the Android Acceptance runner refuses an uncommitted tree, and copying the
  changes into a throwaway clone verifies a commit that never ships.
- Defer only new infrastructure or a large feature (e.g. toast action buttons for undo) as scoped
  follow-ups; do not improvise them mid-batch. Routine product choices were already decided in §4.
- A render fix is verified by re-sampling the same scenario at the same instance state and
  reporting before → after counts, not by "feels faster". Lower state to its consumers instead of
  adding memo barriers; the Renderer runs React Compiler, so a hand-written `React.memo` is a smell
  that the real owner was left in place.

## Related skills

- **acceptance**: owns the desktop-lease launch scripts the visual phase must use.
- **react-rerender-audit**: the general method behind the render layer (localizing the exact hook,
  remount boundaries, Profiler regression tests). Load it when a render finding needs a root cause
  deeper than the scenario table shows.
- **performance**: owns Caxri's benchmarks and the receipt contract. A budget or gate belongs
  there; this skill only audits.
- **deep-review**: merge-readiness review of a change; this skill audits experience quality
  across a scope instead.
- **competitors**: consult for class norms before judging a surface another product solved.
- **audit-architecture-debt**: the same audit shape aimed at structure instead of UX.

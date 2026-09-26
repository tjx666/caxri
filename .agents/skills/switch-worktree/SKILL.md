---
name: switch-worktree
description: Create, resolve, diagnose, run, and safely remove isolated Caxri Git worktrees. Use when a user asks to create or switch to a worktree, develop in an isolated worktree, inspect worktree health, start an isolated development instance, or serialize a macOS Electron desktop task.
---

# Switch Worktree

Use the deterministic CLI from any checkout linked to the Caxri repository:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts <command>
```

Pass `--json` when another tool or agent will consume the result.

## Default delivery flow

An isolated worktree is a self-contained development environment: its branch, dependencies, and
profile cannot disturb the primary checkout or sibling agent sessions. That isolation is the point
— when the user asks to switch to a worktree to get work done (e.g. "切 worktree 处理 issue #123"
or "切 worktree 做一下"), they are delegating the entire development loop, including commit,
push, PR creation, CI, merge, issue closeout, and primary-checkout synchronization. This applies
equally when the request arrives midway through an existing conversation. A run under the `go`
workflow follows `go`'s own orchestration instead. Inspection, listing, and dev-launch-only requests
do not activate this delivery flow. Run it end to end without pausing for permission between stages:

Reuse an existing related worktree and branch for follow-up implementation, bug reports, and
corrections in the same conversation. They are one delivery batch by default, even when they arrive
as separate messages. Do not create a worktree merely because another defect was reported. Create
one only when the user explicitly asks, or after explaining why another checkout is necessary and
receiving confirmation through the question tool. Once this delivery flow is active, the user does
not need to say "commit", "open a PR", or "merge" separately. Only an explicit analysis-only,
local-only, or no-merge restriction narrows that scope.

1. Ensure a GitHub issue tracks the task: when the request references an existing issue, use it;
   otherwise create one first (`gh issue create`, Simplified Chinese title and body, technical
   identifiers in English) capturing the request, scope, and acceptance expectations, then link it
   from the branch work and the eventual PR.
2. Implement and validate the change in the isolated worktree.
3. Review the completed local work (light `deep-review` scope) and repair validated P0/P1 findings.
4. Call the Skill tool with "pull-request" to push the branch and create or update the delivery
   batch's single pull request.
5. Keep one current CI run for the batch. Cancel an obsolete run before re-pushing, then watch the
   replacement, repair failures, and re-push until checks are green. Do not enqueue sibling pull
   requests against the shared runner for fixes that belong to the same delivery.
6. Merge the PR, close the linked issues, and synchronize the primary checkout.
7. File a GitHub issue (same language conventions) for any debt or follow-up the delivery leaves
   behind — deferred findings, known flakes, consciously skipped scope — so nothing survives only
   in the session transcript.

Narrow this flow only when the user explicitly limits delivery (e.g. "只实现，不提交" or
"只分析"). Do not infer implementation-only scope from casual wording, the timing of the request,
or the absence of a separate "open a PR" or "merge" instruction. Pause for discussion when review
or CI exposes a real product decision; when the user pauses execution to ask a question, answer it
without treating that pause as cancellation of the remaining delivery steps.

Before reporting completion, verify every applicable step above against current evidence. Passing
local checks is not completion while PR creation, CI, merge, issue closeout, or synchronization is
still pending. Continue authorized work; if a concrete blocker prevents progress, report the exact
unfinished step and blocker instead of declaring the task complete.
Also check the original request and any supplied handoff for explicit final deliverables, and verify
each against current evidence. A merged PR or Acceptance round does not satisfy an omitted artifact,
report, or handoff requirement.

When a user correction changes the owning checkout, carry the original task and this delivery
checklist forward in the existing worktree whenever possible. Moving the implementation is an
exception that requires the user's explicit request or confirmation, not an automatic repair. A
request to adjust contributor instructions during that work does not cancel the remaining delivery
steps unless the user explicitly says to stop or narrow delivery.

At entry, record which delivery steps are complete and which remain. A generic instruction to
avoid unrequested remote mutations does not narrow this explicitly activated workflow: the request
that activates it supplies that authorization. Honor a task-specific restriction instead when the
user explicitly limits the current run.

Queued or running CI, a busy shared runner, and ordinary check latency are waiting states, not
reasons to end the turn or mark the issue `Blocked`. Keep the primary agent responsible for delivery
while following the `pull-request` skill's harness-specific CI watcher protocol, including
[Codex Watch Await](../../references/codex-watch-await.md). Delegating the wait does not delegate
inspecting the result, repairing failures, or completing the authorized merge. Status questions do
not pause delivery or require the user to request continuation. Stop only for an explicit user
pause or a concrete decision, missing authority, or failed infrastructure that cannot be recovered
within scope; ordinary queue length and elapsed time do not satisfy that exception.

When repeated CI failures expose a previously tracked defect outside the PR's code, preserve the
failed runs and report the exact blocker. Do not create a separate repair worktree unless the user
explicitly requests or confirms that split.

## Create or resolve a checkout

Resolve and reuse an existing checkout whenever the current delivery already owns one. Starting a
new delivery from the primary checkout runs `create` directly. A session that already owns a task
worktree needs the user's explicit request, or their confirmation after the agent explains why the
current worktree cannot own the change, before creating a second one.

Create a semantic branch from the latest `origin/main`, install independent dependencies with `ni`,
prepare native `node-pty` artifacts, and initialize an isolated Caxri profile:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts create feat/example
```

Use `--base <ref>` only when the task explicitly requires another baseline. Allowed new-branch
prefixes are `feat/`, `fix/`, `refactor/`, `perf/`, `docs/`, `test/`, and `chore/`.

Resolve an existing branch or worktree path with:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts switch feat/example
```

The command prints the target path. Use that path as the working directory for later tool calls;
do not expect a child process to change the parent shell's directory. If Git already has the branch
checked out elsewhere, reuse the reported path.

After a completed PR has merged, a genuinely new delivery may reuse the same clean linked
worktree on a fresh branch. Fetch `origin/main`, then target that worktree explicitly with
`rtk git -C <absolute-worktree-path> switch -c <branch> origin/main`. The primary-checkout
guard resolves the target from the command; a bare `rtk git switch` can be misclassified as a
primary-checkout mutation even when the command runner's working directory is the linked worktree.
Never switch branches in the primary checkout.

## Inspect and diagnose

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts list --json
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts doctor [branch-or-path] --json
```

Treat a symlinked `node_modules`, missing profile, or missing dependencies as blocking. `list`
reports Git status, ahead/behind counts, dependency state, isolated profile, dev process identity,
and the repository-wide desktop lease.

## Start development

Run Caxri through the wrapper so every worktree receives a stable, independent `userData` path.
Unpackaged launches default to an isolated `caxri-dev` profile so they never contend with
`/Applications/Caxri.app`; `CAXRI_USER_DATA_DIR` overrides it.

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev
```

Do not link `node_modules` across worktrees. Each checkout runs `ni`; native Electron dependencies
and build outputs remain local. Vite owns Renderer port selection.

## Stop what this checkout started

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts stop
```

Stops the recorded `dev` launcher with its whole subtree, plus anything still executing out of this
worktree after an interrupted run. An orphaned `Caxri Dev` main process is selected only when a
worktree-owned child and its exact cwd confirm ownership. SIGTERM comes first, SIGKILL only for
survivors; a final process scan fails if a child was restarted or ownership could not be confirmed.

Never substitute a name or bundle match. `pkill -f "Caxri.app"` matches `/Applications/Caxri.app`
and has already terminated the installed app mid-session; `pkill -f Electron` matches every Electron
app on the machine. Ownership is a path and a process record, never a name.

## Serialize desktop work

Electron E2E helpers, performance benchmarks, and Acceptance acquire the shared lease themselves.
For another real desktop task, wrap the complete command:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts desktop \
  --label "focused Electron check" -- <command> [args...]
```

Never bypass the lease for a task that launches Electron, takes screenshots, opens native dialogs,
or measures desktop performance. A verified live owner blocks the second task; a stale PID is
reclaimed only when its process start identity no longer matches.

The lease serializes repository-owned Electron desktop jobs between agent sessions. It does not
reserve the developer's macOS keyboard focus or active application: those are user-global resources
outside repository process coordination. Acquiring the lease therefore never authorizes taking or
retaining foreground control. Prepare visible or native actions while backgrounded, then limit each
foreground interval to one pre-authored interaction, its capture or readback, and immediate
dismissal. If the result is unexpected, dismiss the owned native UI and stop the owned launch
before investigating. Never iterate on Accessibility actions, synthesized input, or timing while
the app remains frontmost, and never manipulate which developer application should regain focus.

## Remove safely

Run removal from another associated checkout:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts remove feat/example
```

The command refuses dirty or untracked files, unpushed commits, an active dev process, the primary
checkout, and a worktree holding the desktop lease. It preserves the Git branch and isolated
profile. Add `--clean-profile` only when the user explicitly wants that profile deleted. Never
force-remove, auto-push, or delete a remote branch.

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
— it is not remote-delivery authority. Creating a worktree under `AGENTS.md` standing orders, or a
request that merely says to work in one, authorizes isolated local implementation and validation.
Issue mutation, commit, push, PR publication, merge, closeout, and primary-checkout synchronization
remain governed by the user's exact request or an explicitly active workflow such as `go`.

When the current request does authorize full delivery, run these applicable stages end to end:

1. Use or create a GitHub issue only when issue mutation is authorized.
2. Implement and validate the change in the isolated worktree.
3. Review the completed local work (light `deep-review` scope) and repair validated P0/P1 findings.
4. Call the Skill tool with "pull-request" to push and publish only when those remote steps are
   authorized.
5. Watch CI on the PR, repair failures, and re-push until checks are green.
6. Merge, close issues, and synchronize the primary checkout only when each operation is inside the
   authorized delivery scope; merge always requires explicit user or active-`go` authority.
7. Publish follow-up debt only when issue mutation is authorized; otherwise preserve it in the local
   handoff.

Before reporting completion, verify every authorized applicable step above against current evidence.
Do not describe an unauthorized remote step as pending work.

When moving an in-progress implementation into a task worktree after a user correction, carry
the original task and this delivery checklist forward. Migration is an intermediate repair, not
a completion boundary. A request to adjust contributor instructions during that work does not
cancel the remaining delivery steps unless the user explicitly says to stop or narrow delivery.

At entry, record which delivery steps are authorized, complete, and still pending. A task-specific
restriction always wins; invoking this skill never widens the request.

Queued or running CI, a busy shared runner, and ordinary check latency are waiting states, not
reasons to end the turn or mark the issue `Blocked`. Keep the primary agent active with the CI
watcher until it can inspect the result, repair failures, and complete the authorized merge. A
background watcher or notification alone does not complete that responsibility. Status questions
do not pause delivery or require the user to request continuation. Stop only for an explicit user
pause or a concrete decision, missing authority, or failed infrastructure that cannot be recovered
within scope; ordinary queue length and elapsed time do not satisfy that exception.

When repeated CI failures expose a previously tracked defect outside the PR's code, preserve the
failed runs and report the exact blocker. Repair it in a separate task worktree only when the current
request or an active workflow explicitly includes that additional scope.

## Create or resolve a checkout

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

Stops the recorded `dev` launcher with its whole subtree — including the `Caxri Dev` window process,
which reports the app name rather than a path — plus anything still executing out of this worktree
after an interrupted run, such as a detached Server Core or a Playwright Electron. SIGTERM first,
SIGKILL only for survivors, and a non-zero exit if anything outlives both.

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

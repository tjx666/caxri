---
name: switch-worktree
description: Create, resolve, diagnose, run, and safely remove isolated Caxri Git worktrees. Use only when explicitly invoked with `$switch-worktree` to manage parallel repository checkouts, start an isolated development instance, inspect worktree health, or serialize a macOS Electron desktop task.
---

# Switch Worktree

Use the deterministic CLI from any checkout linked to the Caxri repository:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts <command>
```

Pass `--json` when another tool or agent will consume the result.

## Default delivery flow

An isolated worktree is a self-contained development environment: its branch, dependencies, and
profile cannot disturb the primary checkout or sibling agent sessions. That isolation is the point —
when the user starts a standalone session and asks to switch to a worktree to get work done (e.g.
"切 worktree 处理 issue #123"), they are delegating the entire development loop, not just the
implementation. This flow governs exactly that standalone-session case; a run under the `go`
workflow follows `go`'s own orchestration instead. Run it end to end without pausing for permission
between stages:

1. Ensure a GitHub issue tracks the task: when the request references an existing issue, use it;
   otherwise create one first (`gh issue create`, Simplified Chinese title and body, technical
   identifiers in English) capturing the request, scope, and acceptance expectations, then link it
   from the branch work and the eventual PR.
2. Implement and validate the change in the isolated worktree.
3. Review the completed local work (light `deep-review` scope) and repair validated P0/P1 findings.
4. Push the branch and open a pull request with the `pull-request` skill.
5. Watch CI on the PR, repair failures, and re-push until checks are green.
6. Merge the PR, close the linked issues, and synchronize the primary checkout.
7. File a GitHub issue (same language conventions) for any debt or follow-up the delivery leaves
   behind — deferred findings, known flakes, consciously skipped scope — so nothing survives only
   in the session transcript.

Stop for discussion instead of merging when review or CI surfaces a real product decision, or when
the user asked for a narrower scope (e.g. implementation or report only).

## Create or resolve a checkout

Create a semantic branch from the latest `origin/main`, install independent dependencies with `ni`,
and initialize an isolated Caxri profile:

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
reports Git status, ahead/behind counts, dependency state, isolated profile, dev process identity, and
the repository-wide desktop lease.

## Start development

Run Caxri through the wrapper so every worktree receives a stable, independent `userData` path:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev
```

Do not link `node_modules` across worktrees. Each checkout runs `ni`; native Electron dependencies
and build outputs remain local. Vite owns Renderer port selection.

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

## Remove safely

Run removal from another associated checkout:

```bash
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts remove feat/example
```

The command refuses dirty or untracked files, unpushed commits, an active dev process, the primary
checkout, and a worktree holding the desktop lease. It preserves the Git branch and isolated
profile. Add `--clean-profile` only when the user explicitly wants that profile deleted. Never
force-remove, auto-push, or delete a remote branch.

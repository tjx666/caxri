# Superset (superset-sh/superset)

_Researched 2026-08-06._

Codex hook follow-up, 2026-09-13: [current wrapper](https://github.com/superset-sh/superset/blob/9b97a7d2972b94b4d034106d862b2d94d15a43e4/packages/agent-setup/templates/codex-wrapper-exec.template.sh) sets a process-specific `CODEX_TUI_SESSION_LOG_PATH`, enables recording, and watches `UserTurn` and approval events for Start/PermissionRequest. Native hooks provide Stop. It also appends `--dangerously-bypass-hook-trust`, which excludes implicit daemon reuse in Codex 0.154.0. Source inspected only; do not copy full session recording into Caxri diagnostics, whose privacy contract excludes Terminal output and transcripts.

- **Positioning**: "Code Editor for the AI Agents Era" — a terminal-first agentic IDE/orchestrator for running an army of CLI coding agents (Claude Code, Codex, OpenCode, Cursor Agent, Gemini CLI, etc.) in parallel, one isolated Git worktree per task, with built-in diff review and editor handoff. Explicitly positions itself as the orchestration layer, not another coding agent.
- **Company/traction**: YC-backed (Batch P26, "Superset: Building the platform for software factories"); founders Avi Peltz, Kiet, Satya. Launched on HN 2026-05-23 (Launch HN, ~108 points). GitHub: ~12.7k stars, ~1.1k forks, ~75+ contributors, "tens of thousands of engineers" per YC listing; used at OpenAI, Google, Vercel, Homebrew, Mastra, browser-use per founders.
- **Tech stack**: Electron desktop app (TypeScript) with a persistent local daemon managing sessions over Unix domain sockets; core functionality also runs as a headless Hono server so the same backend serves the desktop app, a `superset` CLI, a TypeScript SDK (`@superset_sh/sdk`), a hosted MCP server (`https://api.superset.sh/mcp`), and future mobile/remote-host clients.
- **License**: Source-available, Elastic License 2.0 (ELv2) — not OSI open source despite "open source" marketing copy; ELv2 forbids offering it as a competing hosted/managed service. (Early commit history briefly used Apache-2.0 before the switch.)

## Architecture highlights

- One `git worktree add -b <branch>` per task/workspace under `~/.superset/worktrees/<project>/<workspace>`, sharing the origin repo's object store; branches default to `agent/<workspace-name>` with configurable prefixes and base-branch selection.
- Persistent background daemon owns all agent/terminal sessions over Unix domain sockets, independent of the UI — sessions and running agents survive app restarts/crashes; priority-based scheduling gives the focused pane full resources while background tabs hydrate gradually.
- Same backend exposed three ways: Electron desktop app, standalone `superset` CLI binary, and a headless Hono server for remote/cloud hosts — enabling "Remote Workspaces" (run agents on a separate machine, manage from the desktop app or, soon, mobile).
- Workspace teardown runs configured teardown scripts, then `git worktree remove --force` and prunes `.git/worktrees` metadata; requires Git 2.20+.

## Standout features

- Parallel Workspaces: run 10+ agents at once, each with its own worktree, branch, terminal, and port allocation; compare results and merge the winner.
- Agent-agnostic: any CLI-based agent works with zero configuration; explicit "fully supported" tier for Claude Code, Codex, Cursor Agent, Gemini CLI, GitHub Copilot, OpenCode, Amp, Droid, and others, plus user-defined custom agents.
- Built-in diff viewer, in-app browser (for docs/dev servers), port management, and one-click "open in IDE" deep links to VS Code/Cursor/JetBrains/Xcode.
- Automations: cron-like scheduled agent runs against a prompt in a fresh or existing workspace.
- MCP server lets other agents (Claude Code, Codex, Cursor) drive Superset itself — create/list/update tasks, workspaces, terminals, and automations programmatically.
- Status/notification layer: working indicators, completion chimes, dock badges when an agent needs review.

## Community sentiment

- Named alongside Codex, Conductor, T3 Code, Orca, Synara, Jean, Trevize, Cloudflare OS, and Paseo/Omnara in a 2026-08-05 X poll of agent workbenches by @T_Zahil (<https://x.com/T_Zahil/status/2085024540355166472>), signaling it's viewed as a top-of-mind entrant in this category.
- Co-founder @FlyaKiet used the same thread to pitch it directly to a developer considering building their own tool: "Don't build your own lol, but @superset_sh" (<https://x.com/FlyaKiet/status/2085094807777759317>) — an unprompted founder-led plug rather than organic third-party endorsement.
- HN Launch thread (2026-05-23, ~135 comments) shows interest driven by the worktree-per-agent pattern and review-bottleneck framing; prior HN post (a few months earlier) covered its "open-source terminal for managing git worktrees" origin before it grew into a full IDE.

## Mobile companion

_Researched 2026-09-24 from source `fd85637d` (2026-09-20)._

- Expo 57 / React Native 0.86 app reaching the Desktop host service through a cloud relay tunnel (JWT auth), with host presence and last-seen offline state.
- Structurally closest to Caxri: the Agent runs in a Terminal shown in a WebView, and a native `TerminalComposer` submits text into it, routing the submit key through the host's Enter path so the TUI does not treat it as a paste (`apps/mobile/screens/(authenticated)/workspace/[id]/WorkspaceScreen/WorkspaceScreen.tsx`).
- New Session picks Project, environment, branch, Agent, and model. Diff review with line comments; a finish-review sheet turns the comments into one Agent prompt. Commits, PRs, checks.
- Lock Screen Live Activity lists up to four Agents. No structured approval UI.

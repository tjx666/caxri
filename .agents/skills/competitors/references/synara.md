# Synara (Emanuele-web04/synara)

_Researched 2026-08-06._

- **Positioning**: Local-first "command center for agentic development": one desktop workspace for chats, terminals, browser previews, diffs, branches, worktrees, and provider sessions across every major agent runtime, so parallel agent work never scatters across a dozen windows.
- **Company/traction**: Solo-led by Emanuele Di Pietro (rebrand of an earlier project, "DP Code" / internal name `t3tools`), with community contributors (incl. Theo/t3dotgg among top contributors); GitHub reports 1,378 stars, 189 forks, 133 open issues; site claims 12,239+ downloads; active weekly releases (v0.6.3 as of research date).
- **Tech stack**: Electron + TypeScript/React monorepo (Turborepo + Bun workspaces), Effect-TS for the app/runtime layer, SQLite via `@effect/sql-sqlite-bun`, Vite dev server, Vitest + oxlint; Astro-based marketing site; some Swift present in the repo for native desktop bits.
- **License**: MIT: open source, permissive.

## Architecture highlights

- MCP-native in both directions: agents running inside Synara automatically get tools to coordinate Synara tasks/automations, while external MCP clients (Codex, Claude Code, Claude Desktop) can connect through a scoped "Synara Agent Gateway" to create tasks, wait for results, steer work, and inspect diagnostics; Synara exposes itself as an MCP server, not just a host.
- Explicit privacy boundary: Synara stores workspace data (chats, projects, history) locally with no Synara-hosted cloud; provider traffic (prompts, diffs, terminal output) goes directly to the chosen provider (Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok, Kilo Code, Pi, Droid), not through a Synara proxy.
- Remote mode supports a web/desktop split via CLI flags (`--mode web|desktop`, `SYNARA_HOME`, WebSocket auth token) for running the same app headless/remotely.
- Worktree-native task isolation: each task/thread can run in its own linked Git worktree so parallel agent runs don't collide on the primary checkout.

## Standout features

- Multi-provider parallelism: run Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok, Kilo Code, Pi, and Factory Droid side by side in the same window, and hand off a thread's full context from one provider to another mid-task.
- One-click PR flow: review diffs, create branches, commit, push, and open GitHub PRs from inside the app; a GitHub CLI-backed PR view groups work by involvement/state with checks, reviewers, and file changes.
- Live process visibility (dev server, test watcher, log tail) plus embedded browser previews beside the agent conversation.
- Studio workspace for long-running, agent-led work kept distinct from regular chats; Automations with scheduling and stop conditions.

## Community sentiment

- Named alongside Orca, Conductor, T3 Code, Herdr, Paseo, and others in a widely-engaged agent-workbench roundup thread (@T_Zahil, 2026-08-05, x.com/T_Zahil/status/2085024540355166472).
- Reply from @NikosGPet (2026-08-06, x.com/NikosGPet/status/2085270846621311159): "it's great! Supports multiple agents talking between them and working together and it has a great interface!": praise for both multi-agent coordination and UI polish.
- Project self-describes as "still very early... expect bugs, rough edges, and fast-moving internals," consistent with its recent rebrand and rapid weekly release cadence.

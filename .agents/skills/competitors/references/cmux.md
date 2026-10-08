# cmux (manaflow-ai/cmux)

_Researched 2026-08-06._

Codex hook follow-up, 2026-09-13: [current injection implementation](https://github.com/manaflow-ai/cmux/blob/309513b40839520d239aed67d420b6e4e06f4e41/CLI/CMUXCLI%2BCodexFireAndForgetHooks.swift#L175-L240) inventories persistent hooks and injects missing events through `-c hooks.<event>=...` plus `--dangerously-bypass-hook-trust`. A complete persistent channel emits no overrides. For Codex 0.154.0, the injected launch flags disable implicit daemon reuse; this is source-based inference, not a local cmux runtime verification. Do not describe this as a demonstrated solution for an environment-less shared daemon.

- **Positioning**: Native macOS terminal (explicitly not Electron) built on libghostty, purpose-built for running many parallel agent sessions, with a notification system that answers "which agent needs me" across many tabs/panes.
- **Company/traction**: Manaflow, Inc. X `@manaflowai`, Discord; Sparkle auto-updates; DMG + Homebrew cask. Users adopt it primarily for the notification system and parallel workspaces despite UI complaints.
- **Tech stack**: Swift + AppKit, libghostty rendering, Go daemon (`daemon/remote`) for SSH/remote-tmux, Bun/TypeScript + React 19 webviews, Biome.
- **License**: GPL-3.0-or-later (reference-only for code).

## Architecture highlights

- `docs/agent-session-tracking-spec.md`: deterministic agent-session binding: injects `CMUX_SURFACE_ID`/`CMUX_WORKSPACE_ID` env vars at terminal spawn so hooks/sessions bind to a durable surface identity; explicitly rejects title-string and mtime heuristics (push is best-effort, pull from persisted state is authoritative). Directly relevant to Caxri's capability-detected metadata indexes.
- Full state restore: windows, workspaces, panes, cwd, scrollback persist across relaunch and computer restart; agent sessions (Claude Code, Codex, OpenCode) resume too.
- `Sources/AgentHibernation`: explicit lifecycle module for suspending/resuming agent processes.
- Go `daemon/remote` handles SSH/remote-tmux attach; browser panes route through the remote network so `localhost` works remotely.
- In-app scriptable browser (ported from Vercel `agent-browser`) plus CLI + Unix-socket API for external scripting.
- "Superrepo" pattern (blog, 2026-07-23): an `AGENTS.md`-driven control repo lets the agent choose worktree vs. multi-checkout vs. remote sandbox per task instead of hardcoding worktrees.

## Standout features

- Notification rings/panel: OSC 9/99/777-driven blue-ring pane + tab glow when an agent needs attention; `cmux notify` CLI hook.
- Vertical tabs showing git branch, PR status, ports, and notification text.
- `cmux claude-teams` spawns Claude teammates as native panes without tmux.
- SSH workspaces with scp drag-drop upload; browser cookie/session import from 20+ browsers; iOS companion app.

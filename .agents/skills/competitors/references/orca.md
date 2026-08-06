# Orca (stablyai/orca)

_Researched 2026-08-06._

- **Positioning**: "Agent Development Environment" (ADE) — desktop app for running many parallel coding-agent CLIs (Claude Code, Codex, OpenCode, …), each in its own git worktree, with terminal, browser, and file editing built in.
- **Company/traction**: Stably, Inc. (YC W22, pivoted from AI QA testing). Daily releases; iOS/Android companion apps; Discord + X `@orca_build`. Aimed at engineers running 10–100 agents at once.
- **Tech stack**: TypeScript/Electron (electron-vite), pnpm monorepo, React renderer, node-pty, SQLite persistence, oxlint/oxfmt, native helpers under `native/`.
- **License**: MIT.

## Architecture highlights

- `src/main/daemon` — detached background daemon owns PTYs, separate from the Electron app lifecycle; app quit does not kill terminals, next launch reattaches via socket + pid file (`listProcesses` + `reattachKnownPtys`). This is why terminals "survive" restarts.
- Fallback when processes truly died: session-scanner maps terminal → agent session id and relaunches per provider (`claude --resume <id>`, `codex resume <id>`, `copilot --resume=<id>`, see `buildAgentResumeInvocation`).
- `src/main/ghostty` + `src/main/pty` — Ghostty-class WebGL terminal rendering with scrollback persisted across restarts.
- Per-provider agent modules (`src/main/claude`, `codex`, `gemini`, `grok`, `pi`, …) plus `agent-hooks`, `usage`, and `rate-limits` for cross-vendor account/usage tracking.
- `src/main/ssh` — remote worktrees over SSH with auto-reconnect and port forwarding.
- Public `orca` CLI (`src/cli`) lets agents script the app itself (worktree create/snapshot/click/fill).

## Standout features

- Parallel worktrees: fan one prompt across N agents, compare and merge results.
- Design Mode: click a UI element in the embedded per-worktree Chromium → HTML/CSS/screenshot into the prompt.
- Annotate AI Diffs: inline PR-style comments fed back to the agent.
- Mobile companion apps to steer agents remotely; native GitHub/Linear browsing in-app; Computer Use.

## Theming

- Arbitrary VS Code/iTerm2 theme import scoped to terminal colors; DEC 2031/CSI 997 theme push to TUIs.

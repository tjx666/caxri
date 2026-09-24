# Paseo (getpaseo/paseo)

_Researched 2026-08-06._

- **Positioning**: Self-hostable orchestrator for coding agents — "one interface for Claude Code, Codex, Copilot, OpenCode, and Pi" that runs agents on your own machines and drives them from desktop, mobile, web, or CLI. Frames itself as not a hosted agent, not an IDE, and not a model provider — it wraps existing CLIs rather than shipping its own agent.
- **Company/traction**: Independent open-source project led by Mohamed Boudra (`boudra`, by far the top contributor); created 2025-10-13. Fast-growing: ~12.2k GitHub stars, ~1.2k forks, 686 open issues as of research date. Ships an Electron desktop app, an Expo (React Native) mobile/web app, a CLI, and Google Play/App Store listings.
- **Tech stack**: Monorepo — `packages/server` (Node.js daemon: agent process orchestration, WebSocket API, MCP server), `packages/app` (Expo client for iOS/Android/web), `packages/cli`, `packages/desktop` (Electron wrapper that can spawn the daemon as a managed subprocess), `packages/relay` (encrypted relay transport, separate repo `getpaseo/paseo-relay` written in Elixir), `packages/website` (TanStack Router + Cloudflare Workers).
- **License**: AGPL-3.0 (GitHub shows "Other" because the LICENSE file is a custom header over the full AGPLv3 text; third-party components keep their own licenses) — copyleft, stricter than Caxri's needs; reference-only for code.

## Architecture highlights

- Client-server split: a local Node.js "daemon" (default `127.0.0.1:6767`) spawns and supervises agent CLI subprocesses and streams output over WebSocket; the desktop app, mobile app, web app, and CLI are all thin clients of the same daemon API — anything in the UI is scriptable via the CLI.
- Agent providers are adapters, not forks: native adapters for Claude Code (Anthropic Agent SDK, reads `~/.claude/projects/{cwd}/{session-id}.jsonl`), Codex (`codex-app-server`, reads `~/.codex/sessions/...`), OpenCode, and Pi, plus a generic Agent Client Protocol (ACP) adapter with a curated one-click catalog (Cursor, Gemini, Copilot, Hermes, Kimi, Qwen Code, 25+ more) and support for adding any ACP agent via `~/.paseo/config.json`.
- Three deployment models documented in `docs/architecture.md`: local daemon only, managed desktop (Electron spawns daemon as subprocess), and remote + relay (daemon behind a firewall, bridged by the optional end-to-end encrypted relay for phone/remote access without opening ports).
- "Workspaces" model: a project/workspace/session hierarchy: `paseo run --new-workspace local|worktree` explicitly creates isolated worktrees per task; work can also happen in any directory without git at all.
- No telemetry; code never leaves the user's machine; agents call their own provider APIs directly instead of Paseo proxying model calls.

## Standout features

- Native mobile app (React Native, not a webview) with declared feature parity to desktop — start a task at a desk, check progress, and send follow-ups from a phone over the encrypted relay or Tailscale.
- CLI-first orchestration primitives (`paseo run`, `paseo ls`, `paseo attach`, `paseo send`) that agents themselves are meant to call — an agent recognized via `PASEO_AGENT_ID` spawning a sub-agent becomes a nested worker in the same workspace automatically.
- Worktree-based review/ship flow: create a branch/worktree, preview the running app in-browser, review an inline diff, then commit/open PR/merge without leaving Paseo.
- Voice control with a local-first speech stack (optional cloud STT/TTS via OpenAI if configured) for hands-free task dictation.
- "Paseo Hub" (new, optional self-hosted service): wires GitHub/Slack/Discord mentions into daemon-triggered agent runs for team access.

## Community sentiment

- X thread, 2026-08-05, [@T_Zahil](https://x.com/T_Zahil/status/2085024540355166472): after trying all the major agent workbenches, the OP said he'd settle on Paseo, praising its server/workspaces model and developer experience, and specifically calling out self-hosting on Mac/VPS with iPhone/iPad control.
- Top-liked reply in the same thread, [@nikuscs](https://x.com/nikuscs/status/2085102963287085190) (also a top-10 GitHub contributor to the repo): picked the combination of Orca + Paseo rather than a single tool.
- paseo.sh's own testimonials wall (developer quotes, not independently verified) repeats similar themes: "most slept on orchestrator," praise for cross-platform parity (Mac/phone/web) and the relay/Tailscale self-hosting story, and comparisons naming it the best of "100s of agent orchestrators" tried.

## Mobile companion

_Researched 2026-09-24 from source `ee7949a` (2026-09-21)._

- One Expo 54 / React Native 0.81 app is the phone, web, and (wrapped by Electron) desktop client. Phones use three swipe panels (Session list ← Agent → files); native tablets get sidebars but no pane splits; the app is portrait-locked.
- Terminal: the daemon streams screen grids and the app draws them natively, with an xterm WebView fallback and a two-row virtual key bar (Esc, Tab, sticky Ctrl/Shift/Alt, arrows, Enter, Paste).
- Agent timeline and permission requests come from structured provider adapters, not Terminal scraping, so approvals are typed responses.
- Composer: model/mode selectors, provider slash commands, image attach, streamed dictation, and a full realtime voice mode.
- Direct host:port (optional TLS/password) or an opt-in relay with Curve25519 E2EE; Tailscale recommended outside the LAN. Push through Expo; SQLite replica cache for timeline catch-up.
- Public sentiment (X, Sept 2026): most praised for a native GUI that is far nicer on a phone than SSH or a TUI; criticized for mobile sessions freezing, weaker connection reliability than Orca, and contending with the official Codex app-server.

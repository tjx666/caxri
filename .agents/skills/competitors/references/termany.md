# Termany (thinkany-ai/termany)

_Researched 2026-08-06._

- **Positioning**: Agent-native terminal (web app + Tauri desktop, cloud service planned) running multiple coding-agent CLIs side by side in split panes, with an integrated file tree/editor and an agent-cost usage dashboard.
- **Company/traction**: ThinkAny, LLC (also makes codeany, dscode, rag-search). ~202 stars, created 2026-06-29: early-stage, low traction; no notable HN/Reddit/Twitter buzz found.
- **Tech stack**: TypeScript pnpm monorepo: `apps/web` (React + xterm.js), `apps/server` (node-pty over WebSocket), `apps/desktop` (Tauri bundling a Node runtime). Built on the ShipAny SaaS starter.
- **License**: AGPL-3.0-only (commercial licensing on request): reference-only for code.

## Architecture highlights

- Single seam `ITerminalBackend` (`packages/core`) with swappable implementations (`WebSocketBackend` today, `LocalPtyBackend` planned): the same UI ships to web, desktop, and future cloud.
- Desktop is Tauri but still spawns a bundled Node/node-pty server locally and talks WebSocket rather than in-process PTY.
- Three-level UI hierarchy: Workspace rail → vertical tab (project) → horizontal tab (live shell); backgrounded tabs persist with scrollback.
- Agent transcripts parsed post-hoc for a cost/usage dashboard (tokens, cost, per-model/per-project) and a session browser that resumes past conversations already `cd`'d to the right project (Claude/Codex supported).
- BYOK model keys stored locally in SQLite (`~/.termany/termany.db`).

## Standout features

- Pane auto-tagging working/done/error derived from PTY output.
- File tree pane (⌘E) with inline preview for markdown/HTML/media/PDF/Office formats plus CodeMirror editing.
- Theme packs via the third-party CodexThemes marketplace; system-wide summon hotkey.
- Roadmap: inline AI command suggestion/diagnosis, cloud container-per-session backend.

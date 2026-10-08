# Otty (closed source, appmakes.io)

_Researched 2026-08-06. No repository: findings from otty.sh docs, Show HN / Product Hunt (2026-06-17); deeper analysis requires inspecting the packaged app._

- **Positioning**: Native GPU-accelerated macOS terminal sitting "between a traditional terminal and a full agent dev environment": keyboard-first UX with first-class observable, resumable agent sessions (Claude Code, Codex, OpenCode, Cursor CLI) and deliberately no IDE-style panel bloat.
- **Company/traction**: Indie studio appmakes.io. Mildly positive HN/PH reception (visuals/UX praised); macOS-only and vague positioning flagged as adoption blockers.
- **Tech stack**: Swift/AppKit/SwiftUI with a Metal GPU rendering grid (author tried Rust/wgpu first); some Rust.
- **License**: Proprietary; local/offline features free forever, only future server-dependent features (sync, remote control, hosted "Otty AI") may become paid.

## Architecture highlights

- Agent integration via lightweight hooks/plugins written into each agent's own config (`~/.claude/settings.json`, `~/.codex/hooks.json`, OpenCode plugin dir, `~/.cursor/hooks.json`) rather than wrapping the agent process: the agent self-reports processing/idle/awaiting-input.
- Proposes vendor-neutral escape-sequence specs: "OSC 26 / Terminal Agent Protocol" (agent identity/status/progress to any terminal) and "Terminal Resume Protocol (OSC 88)", worth tracking as potential cross-product standards for Caxri's agent-state detection.
- Session recovery restores the previous terminal layout and reattaches tmux sessions after restart.
- Deliberately narrow feature surface to keep the terminal fast and uncluttered, same product philosophy as Caxri's intentionally narrow editor.

## Standout features

- Per-agent one-click hook install with tab badges + system notifications (processing/complete/awaiting-input).
- Monitor Tasks dashboard for parallel agent runs; session History with resume; Fork/Branch a chat session.
- Composer + Prompt Queue for drafting/queueing prompts; "Send to Chat" pipes terminal output into an agent.

## Community sentiment

- Compared directly to cmux and Ghostty; feedback centers on session-recovery depth (process state vs. scrollback vs. layout) and macOS-only availability.

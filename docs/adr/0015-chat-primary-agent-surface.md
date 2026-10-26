---
kind: adr
status: accepted
---

# Agent Chat is the primary Agent surface; the Terminal surface stays supported

- Date: 2026-10-13
- Refs: [#2074](https://github.com/tjx666/caxri/issues/2074)
- Amends: [ADR 0012](0012-agent-chat-surface.md)

[ADR 0012](0012-agent-chat-surface.md) added the Chat surface beside the PTY without ranking them,
while the README still called Caxri "terminal-native". Since then nearly every new Agent capability
(fork, rewind, per-turn diff review, the Context tab, Codex goals) has shipped on Chat only, and in
daily use Chat proved the more capable surface. A Chat receives structured provider events (tool
calls, file edits, approvals, questions, token usage) that Caxri can build on; a PTY exposes only
a terminal grid that Caxri can decorate but not understand.

**Decision**: Chat is the primary Agent surface and the default target for new Agent-facing
features. The PTY Terminal surface is permanent and must stay usable.

- **Chat first, not Chat only.** A new Agent capability is designed for Chat. It may ship
  Chat-only; the two surfaces are not required to reach feature parity.
- **Terminal is never removed or degraded.** Launching, typing into, resuming, switching surface,
  suspending, and restoring a PTY Agent keep working. Chat work must not regress those paths, and a
  Terminal regression is a bug, not accepted debt.
- **Terminal remains the fallback.** Shells, Agents without `capabilities.chat`, and vendor
  features Chat has not adopted yet stay reachable through the PTY, and `terminal.switchSurface`
  keeps one conversation movable between both surfaces.
- **Agents open in Chat by default (decided 2026-10-27).** `session.openAgentsInChat` defaults to
  true, so a new user's first Agent starts as a Chat. Shell still opens in a Terminal, an Agent
  without `capabilities.chat` falls back to the PTY, and a user's explicit setting is never
  rewritten; only the default changed.

## Consequences

Chat inherits the cost the PTY avoided: each provider protocol upgrade (Codex `app-server`, the
Claude Agent SDK, Grok Build's ACP) needs Caxri-side adaptation, and a vendor's new TUI feature
reaches Chat only after Caxri implements it. The Terminal surface is what keeps those gaps from
blocking the user.

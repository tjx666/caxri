# Kooky (iAmCorey/kooky)

_Researched 2026-08-06._

- **Positioning**: "A minimal modern terminal for AI coding": native macOS SwiftUI terminal built around one-click agent launch, per-agent activity readout, and session resume across 15 CLI agents.
- **Company/traction**: Solo indie (Corey Chiu). ~608 stars since 2026-05; aggressive weekly release cadence (5 → 15 built-in agents in a few months). Adhoc-signed DMG only, notarization deferred: pre-scale distribution. "Local by default", no telemetry/accounts.
- **Tech stack**: Swift 6.2 / SwiftUI (`@Observable`, macOS 14+), libghostty Metal rendering, SPM multi-target (`Kooky`, `KookyKit`, plus tiny `KookyHook` CLI).
- **License**: MIT.

## Architecture highlights

- Dedicated dependency-free `KookyHook` executable invoked from Claude Code/Codex hooks: reads `$KOOKY_SURFACE_ID`, writes one JSON line to a Unix socket the app owns, exits: same durable-surface-identity idea as cmux's env-token spec.
- Reads each agent's **native on-disk session format** directly (13+ formats parsed individually) to power resume: closing/reopening a tab resumes via the agent's own session ID, the same approach as Caxri's capability-detected metadata indexes, at larger provider coverage.
- Git-worktree-first workflow: right-click "Create Worktree…" nests worktrees under the source repo in the sidebar; CLI-created worktrees auto-appear on next launch.
- Per-agent activity state machine (running / waiting-on-you / idle, tool-call pill with duration) driven by a shell-integration wrapper uniform across zsh/bash/fish.
- SSH workspaces reuse one shared connection per host; remote agent tabs load the remote shell rc so nvm-installed tools resolve.
- Explicit security posture: paste-injection confirmation for unbracketed multi-line paste, permission-gated OSC-52 clipboard, secure keyboard input during sudo/ssh, command lines kept in-memory only.

## Standout features

- Agent panel across windows sorted by "who needs you first" (waiting > failed > running > idle); Session History browses/resumes past conversations across 13 agents, including ones started outside Kooky.
- Session Info inspector: live process tree with CPU/mem/ports, git/venv/node/proxy state, last exit code, plus an "Ask AI" button that hands a failed command's context to an agent.
- Keep-awake toggle (Off/Auto/Always) tracking live agent/SSH activity, bidirectional with `pmset`/caffeinate.
- "Bring your own agent": custom agents by name+command, inheriting a built-in's icon/launch/activity tracking, with per-agent env vars (e.g. custom Anthropic base URL).
- Right-click selection → "Ask <agent>"; chat-style prompt composer (⌘L); sidebar file tree with live `+X −Y` diff rollups.

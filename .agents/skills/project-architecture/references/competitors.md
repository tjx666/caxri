# Competitor and adjacent-product references

Products in or near Caxri's space (terminal-native workbenches for AI coding agents). Consult
them for design and implementation ideas — how they solve theming, agent-state detection, session
persistence, worktree isolation, or multi-agent orchestration — before inventing a new approach.
Never copy code without checking the license.

## Agent workbench terminals (direct competitors)

| Product     | Repository                               | Notes                                                                                                                        |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Orca        | <https://github.com/stablyai/orca>       | Electron + Tailwind v4; arbitrary VS Code/iTerm2 theme import scoped to terminal colors; DEC 2031/CSI 997 theme push to TUIs |
| cmux        | <https://github.com/manaflow-ai/cmux>    | Ghostty-based native macOS terminal with agent notifications and draggable panes                                             |
| Muxy        | <https://github.com/muxy-app/muxy>       | SwiftUI + libghostty; project groups, extensions API, mobile companions, 490+ themes                                         |
| Kero        | <https://github.com/egoist/kero>         | Swift + libghostty; projects/sessions model, Git panel with inline diffs, files panel — closest product shape to Caxri       |
| Termany     | <https://github.com/thinkany-ai/termany> | AGPL-3.0; same UI as web app and desktop client, local-first with a swappable cloud backend                                  |
| Herdr       | <https://github.com/herdrdev/herdr>      | Rust TUI multiplexer daemon; agent working/blocked/idle detection, socket API agents drive themselves                        |
| Mux (Coder) | <https://github.com/coder/mux>           | Desktop control plane for parallel agentic development, git-worktree isolation                                               |

## Agent CLIs Caxri hosts

| Product     | Repository                                  | Notes                                                                        |
| ----------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| Claude Code | <https://github.com/anthropics/claude-code> | Primary hosted agent; transcript/metadata formats under `~/.claude/projects` |
| Codex       | <https://github.com/openai/codex>           | Session rollouts under `~/.codex/sessions`                                   |
| Grok Build  | <https://github.com/xai-org/grok-build>     | xAI agent CLI; several community desktop wrappers exist                      |

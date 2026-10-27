# Competitor and adjacent-product references

Products in or near Caxri's space (Agent development environments and workbenches for AI coding
agents). Consult
them for design and implementation ideas (how they solve theming, agent-state detection, session
persistence, worktree isolation, or multi-agent orchestration) before inventing a new approach.
Never copy code without checking the license.

All repositories below are shallow-cloned into the git-ignored top-level `competitors/` directory
for local analysis; run `../scripts/sync.sh` to clone/update them all and list each clone's latest
commit time. Per-product research notes live beside this file as `<product>.md`.

## Agent workbench terminals (direct competitors)

| Product     | Repository                                 | Notes                                                                                                                        |
| ----------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Orca        | <https://github.com/stablyai/orca>         | Electron + Tailwind v4; arbitrary VS Code/iTerm2 theme import scoped to terminal colors; DEC 2031/CSI 997 theme push to TUIs |
| cmux        | <https://github.com/manaflow-ai/cmux>      | Ghostty-based native macOS terminal with agent notifications and draggable panes                                             |
| Muxy        | <https://github.com/muxy-app/muxy>         | SwiftUI + libghostty; project groups, extensions API, mobile companions, 490+ themes                                         |
| Kero        | <https://github.com/egoist/kero>           | Swift + libghostty; projects/sessions model, Git panel with inline diffs, files panel: closest product shape to Caxri        |
| Termany     | <https://github.com/thinkany-ai/termany>   | AGPL-3.0; same UI as web app and desktop client, local-first with a swappable cloud backend                                  |
| Herdr       | <https://github.com/herdrdev/herdr>        | Rust TUI multiplexer daemon; agent working/blocked/idle detection, socket API agents drive themselves                        |
| Mux (Coder) | <https://github.com/coder/mux>             | Desktop control plane for parallel agentic development, git-worktree isolation                                               |
| Kooky       | <https://github.com/iAmCorey/kooky>        | MIT, Swift; sidebar workspaces, split panes, one-click agent launch, per-agent activity readout                              |
| Warp        | <https://github.com/warpdotdev/Warp>       | AGPL-3.0, Rust; agentic development environment born out of the terminal: largest codebase in this list                      |
| Otty        | closed source                              | No public repository; analyze via the packaged app when needed                                                               |
| Conductor   | closed source                              | Tauri + React macOS multi-agent IDE (Melty Labs, $22M Series A); worktree workspaces, PR/checks UI, checkpoints              |
| Superset    | <https://github.com/superset-sh/superset>  | Elastic License 2.0 (source-available, reference-only); Electron orchestrator, worktree-per-agent, MCP/CLI/SDK control       |
| Paseo       | <https://github.com/getpaseo/paseo>        | Apache-2.0; self-hosted daemon + Electron/Expo mobile/CLI clients for Claude Code, Codex, Copilot, OpenCode, Pi              |
| T3 Code     | <https://github.com/pingdotgg/t3code>      | MIT; multi-device (web/desktop/mobile) control surface wrapping Claude Code/Codex/Cursor/Grok/OpenCode; Effect RPC server    |
| Synara      | <https://github.com/Emanuele-web04/synara> | MIT; Electron + Effect-TS multi-provider command center; worktree-isolated parallel agents, MCP both ways                    |
| Jean        | <https://github.com/coollabsio/jean>       | Apache-2.0; Tauri v2 + React opinionated agent workbench by the Coolify team; worktrees, GitHub/Linear integrations          |
| Omnara      | <https://github.com/omnara-ai/omnara>      | YC S25 remote-control layer (mobile/voice/push) for Claude Code/Codex; Apache-2.0 repo archived 2026-02, v2 backend closed   |
| Trevize     | closed source                              | Cloud-hosted multiplayer agent workspaces with per-session preview envs and DB branching; no local client                    |

## Agent CLIs Caxri hosts

| Product     | Repository                                  | Notes                                                                        |
| ----------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| Claude Code | <https://github.com/anthropics/claude-code> | Primary hosted agent; transcript/metadata formats under `~/.claude/projects` |
| Codex       | <https://github.com/openai/codex>           | Session rollouts under `~/.codex/sessions`                                   |
| Grok Build  | <https://github.com/xai-org/grok-build>     | xAI agent CLI; several community desktop wrappers exist                      |

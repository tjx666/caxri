# Herdr (herdrdev/herdr)

_Researched 2026-08-06._

- **Positioning**: "The runtime coding agents run on": a Rust, no-Electron, always-on background server owning real PTY panes for existing agent CLIs, tracking each pane's working/blocked/idle state and surviving detach, lid-close, and reboot.
- **Company/traction**: herdrdev (lead `ogulcancelik`). ~24.8k stars since 2026-03-27; two front-page HN launches (one at 404 points/178 comments); sponsored by Terminal Trove; plugin ecosystem ("Herdr Plus").
- **Tech stack**: Pure Rust: ratatui/crossterm TUI, tokio, vendored `portable-pty` fork, `interprocess` sockets, vendored `libghostty-vt` for terminal parsing; Windows via windows-sys/wmi. Single binary.
- **License**: Apache-2.0.

## Visible delegation reference (2026-09-10)

Verified local source at `b9ce96869e89937278d673d70ae4c135dd318469`:

- `skills/herdr/SKILL.md:95` creates a sibling pane in the caller's tab and cwd. Wide panes split
  right; narrow or tall panes split down. `pane split --no-focus` preserves the caller's focus.
- `src/app/api/panes.rs:34` passes `params.focus` through the layout operation and only switches
  the active workspace/tab and records a focus change when it is true.
- `agent start` uses an existing available shell pane; it does not create layout. The caller uses
  the returned pane identity to start and then prompt the Agent.
- `src/app/api/agents.rs:106` rejects blocked or replaced Agents before ordered prompt submission.
  Submission acknowledgement is separate from observed work and from the settled-state wait.
- The documented wait observes lifecycle, not a task identity. Reading the recent terminal screen
  also cannot guarantee a complete answer. Caxri issue #686 therefore adopts the sibling-pane UX
  while requiring exact task/turn correlation and authorized durable result retrieval separately.

Sources: [coordination workflow](https://github.com/herdrdev/herdr/blob/b9ce96869e89937278d673d70ae4c135dd318469/skills/herdr/SKILL.md#L95),
[pane split](https://github.com/herdrdev/herdr/blob/b9ce96869e89937278d673d70ae4c135dd318469/src/app/api/panes.rs#L34),
[prompt admission](https://github.com/herdrdev/herdr/blob/b9ce96869e89937278d673d70ae4c135dd318469/src/app/api/agents.rs#L106).

## Architecture highlights

- Server/client split: `herdr-server` owns panes and process state persistently; TUI clients attach/detach without killing agents. Their CLAUDE.md enforces a "runtime/client boundary": new features go to server-owned state exposed via a JSON API, never client-only hacks.
- Layered, evidence-based agent-state detection: lifecycle hooks/plugins are authoritative when installed (Claude Code hooks, OpenCode/Kilo plugins); fallback reads a live bottom-buffer screen snapshot against per-agent TOML manifests (`src/detect/manifests/*.toml`) to classify idle/working/blocked. "Blocked" is deliberately strict (must match known approval/question UI).
- Detection manifests are hot-reloadable and remotely updatable (fetched from herdr.dev, cached, applied without restart), new detection rules decoupled from binary releases.
- The socket API + CLI is the same surface agents themselves drive (spawn panes, prompt each other, wait for "genuinely blocked"), enables agent-to-agent orchestration without polling.
- Session/workspace/tab/pane persistence with restore-on-restart; `herdr --remote` thin-client mode bridges local clipboard/image paste to a remote server.
- Strict state/render separation (`AppState` pure data, `PaneState` vs `PaneRuntime`, pure `render()`).

## Standout features

- Four-state pane badges (working/blocked/idle/done) rolled up to tab and workspace level in one sidebar.
- Always-on server: lid close, network drop, or machine restart doesn't kill agents; reattach from any terminal or phone over SSH.
- `herdr agent attach <name>` attaches a single agent pane without the full TUI.
- `herdr agent explain <pane>` shows exactly which detection rule/evidence produced a state: transparent heuristics debugging.
- Mouse-first TUI plus full tmux-style prefix bindings.

## Community sentiment

- HN praise: SSH/Tailscale mobile access, replacing tmux/Zellij, socket API for custom tooling. Criticism: default keybindings, copy/paste friction in WezTerm, beta Windows support, screen-scraping edge cases (alexdunlop.com comparison, 2026-06-22).

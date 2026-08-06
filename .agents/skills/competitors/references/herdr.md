# Herdr (herdrdev/herdr)

_Researched 2026-08-06._

- **Positioning**: "The runtime coding agents run on" — a Rust, no-Electron, always-on background server owning real PTY panes for existing agent CLIs, tracking each pane's working/blocked/idle state and surviving detach, lid-close, and reboot.
- **Company/traction**: herdrdev (lead `ogulcancelik`). ~24.8k stars since 2026-03-27; two front-page HN launches (one at 404 points/178 comments); sponsored by Terminal Trove; plugin ecosystem ("Herdr Plus").
- **Tech stack**: Pure Rust — ratatui/crossterm TUI, tokio, vendored `portable-pty` fork, `interprocess` sockets, vendored `libghostty-vt` for terminal parsing; Windows via windows-sys/wmi. Single binary.
- **License**: Apache-2.0.

## Architecture highlights

- Server/client split: `herdr-server` owns panes and process state persistently; TUI clients attach/detach without killing agents. Their CLAUDE.md enforces a "runtime/client boundary": new features go to server-owned state exposed via a JSON API, never client-only hacks.
- Layered, evidence-based agent-state detection: lifecycle hooks/plugins are authoritative when installed (Claude Code hooks, OpenCode/Kilo plugins); fallback reads a live bottom-buffer screen snapshot against per-agent TOML manifests (`src/detect/manifests/*.toml`) to classify idle/working/blocked. "Blocked" is deliberately strict (must match known approval/question UI).
- Detection manifests are hot-reloadable and remotely updatable (fetched from herdr.dev, cached, applied without restart) — new detection rules decoupled from binary releases.
- The socket API + CLI is the same surface agents themselves drive (spawn panes, prompt each other, wait for "genuinely blocked") — enables agent-to-agent orchestration without polling.
- Session/workspace/tab/pane persistence with restore-on-restart; `herdr --remote` thin-client mode bridges local clipboard/image paste to a remote server.
- Strict state/render separation (`AppState` pure data, `PaneState` vs `PaneRuntime`, pure `render()`).

## Standout features

- Four-state pane badges (working/blocked/idle/done) rolled up to tab and workspace level in one sidebar.
- Always-on server: lid close, network drop, or machine restart doesn't kill agents; reattach from any terminal or phone over SSH.
- `herdr agent attach <name>` attaches a single agent pane without the full TUI.
- `herdr agent explain <pane>` shows exactly which detection rule/evidence produced a state — transparent heuristics debugging.
- Mouse-first TUI plus full tmux-style prefix bindings.

## Community sentiment

- HN praise: SSH/Tailscale mobile access, replacing tmux/Zellij, socket API for custom tooling. Criticism: default keybindings, copy/paste friction in WezTerm, beta Windows support, screen-scraping edge cases (alexdunlop.com comparison, 2026-06-22).

# Orca (stablyai/orca)

_Researched 2026-08-06._

Codex hook follow-up, 2026-09-13: [current hook script](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/codex/codex-hook-script.ts) refreshes port/token from the file named by `ORCA_AGENT_HOOK_ENDPOINT` before HTTP delivery. This supports surviving PTYs after Server restart, but still requires that environment variable and `ORCA_PANE_KEY`; its spool also requires both. Therefore this path alone does not solve completely missing shared-daemon environment. Source inspected only, not a live Orca reproduction.

- **Positioning**: "Agent Development Environment" (ADE): desktop app for running many parallel coding-agent CLIs (Claude Code, Codex, OpenCode, …), each in its own git worktree, with terminal, browser, and file editing built in.
- **Company/traction**: Stably, Inc. (YC W22, pivoted from AI QA testing). Daily releases; iOS/Android companion apps; Discord + X `@orca_build`. Aimed at engineers running 10–100 agents at once.
- **Tech stack**: TypeScript/Electron (electron-vite), pnpm monorepo, React renderer, node-pty, SQLite persistence, oxlint/oxfmt, native helpers under `native/`.
- **License**: MIT.

## Architecture highlights

- `src/main/daemon`: detached background daemon owns PTYs, separate from the Electron app lifecycle; app quit does not kill terminals, next launch reattaches via socket + pid file (`listProcesses` + `reattachKnownPtys`). This is why terminals "survive" restarts.
- Fallback when processes truly died: session-scanner maps terminal → agent session id and relaunches per provider (`claude --resume <id>`, `codex resume <id>`, `copilot --resume=<id>`, see `buildAgentResumeInvocation`).
- `src/main/ghostty` + `src/main/pty`: Ghostty-class WebGL terminal rendering with scrollback persisted across restarts.
- Per-provider agent modules (`src/main/claude`, `codex`, `gemini`, `grok`, `pi`, …) plus `agent-hooks`, `usage`, and `rate-limits` for cross-vendor account/usage tracking.
- `src/main/ssh`: remote worktrees over SSH with auto-reconnect and port forwarding.
- Public `orca` CLI (`src/cli`) lets agents script the app itself (worktree create/snapshot/click/fill).

## Standout features

- Parallel worktrees: fan one prompt across N agents, compare and merge results.
- Design Mode: click a UI element in the embedded per-worktree Chromium → HTML/CSS/screenshot into the prompt.
- Annotate AI Diffs: inline PR-style comments fed back to the agent.
- Mobile companion apps to steer agents remotely; native GitHub/Linear browsing in-app; Computer Use.

## Theming

- Arbitrary VS Code/iTerm2 theme import scoped to terminal colors; DEC 2031/CSI 997 theme push to TUIs.

## Mobile companion

_Researched 2026-09-24 from source `963da57c` (2026-09-21)._

- Separate Expo 55 / React Native 0.83 app under `mobile/`. Terminal is xterm 6 in a WebView with an accessory key row (modifier builder, key repeat), a "Live" mode that forwards each keystroke, pinch zoom, and tappable paths/URLs.
- Desktop keeps a per-PTY `mobileSubscribers` map (`src/main/runtime/orca-runtime-on-client-disconnected.ts`) and hydrates a newly attached mobile subscriber with the serialized buffer, so Desktop and phone observe the same PTY concurrently.
- Native chat view parses the provider's own JSONL transcript (Claude, Codex, Grok). Permission cards are detected heuristically from transcript text and answered by writing `y`/`1` to the PTY.
- Pairing via QR or `orca://pair` link; NaCl box E2EE also on direct LAN sockets. Paths are labeled `lan` / `tailscale` / `relay`; the vendor relay requires an account. Multi-host routes `app/h/[hostId]/…`.
- Wide layout requires width ≥ 700 and short side ≥ 600, so landscape phones stay in the phone layout; the host list is a resizable sidebar and Source Control / Files / PR dock beside the Terminal.
- Also: worktree creation and Agent launch, source control with commit, diff review with comments sent to the Agent, PR screen, push via a vendor gateway, dictation transcribed on Desktop, cached home snapshot for cold start, protocol version gate.
- Public sentiment (X, Sept 2026): most praised for connection reliability and multi-device pairing over Tailscale; criticized for a less complete, less native-feeling mobile UI than Paseo.

## Chat and Terminal switching

_Researched 2026-10-10._

- Chat is an overlay on the live PTY rather than a second process: a pane header icon button, `⌘⇧J`, and a Terminal context menu entry toggle it with no restart.
- The overlay's content is derived from the transcript and approvals are answered by synthesizing `1` or arrow keys into the PTY, which is fragile. Caxri's ADR 0012 rejected this overlay model.
- Caxri reused the `⌘⇧J` chord for `terminal.switchAgentSurface`.

## Plan limit window labels

_Researched 2026-10-21 at `98e7dbecfedb732abc2358c8aff4a5d7e98f642a`._

- The status bar usage chip names the 5-hour window `5h` and the weekly window `wk`
  (`src/renderer/src/lib/window-label-formatter.ts`); its comment says `wk` is kept for compatibility with the
  original status bar. Chinese uses `5小时` and `周`; the tooltip spells the window out as `Weekly` / `每周`.
- The mobile usage bars use `7d` / `7天` instead, so Orca itself is not consistent across surfaces.
- Caxri's usage chip follows the desktop chip: `wk` in English, `本周` in Chinese, because `7d` beside a remaining
  share reads as days until reset.

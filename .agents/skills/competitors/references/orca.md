# Orca (stablyai/orca)

_Researched 2026-08-06._

Codex hook follow-up, 2026-09-13: [current hook script](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/codex/codex-hook-script.ts) refreshes port/token from the file named by `ORCA_AGENT_HOOK_ENDPOINT` before HTTP delivery. This supports surviving PTYs after Server restart, but still requires that environment variable and `ORCA_PANE_KEY`; its spool also requires both. Therefore this path alone does not solve completely missing shared-daemon environment. Source inspected only, not a live Orca reproduction.

- **Positioning**: "Agent Development Environment" (ADE) — desktop app for running many parallel coding-agent CLIs (Claude Code, Codex, OpenCode, …), each in its own git worktree, with terminal, browser, and file editing built in.
- **Company/traction**: Stably, Inc. (YC W22, pivoted from AI QA testing). Daily releases; iOS/Android companion apps; Discord + X `@orca_build`. Aimed at engineers running 10–100 agents at once.
- **Tech stack**: TypeScript/Electron (electron-vite), pnpm monorepo, React renderer, node-pty, SQLite persistence, oxlint/oxfmt, native helpers under `native/`.
- **License**: MIT.

## Architecture highlights

- `src/main/daemon` — detached background daemon owns PTYs, separate from the Electron app lifecycle; app quit does not kill terminals, next launch reattaches via socket + pid file (`listProcesses` + `reattachKnownPtys`). This is why terminals "survive" restarts.
- Fallback when processes truly died: session-scanner maps terminal → agent session id and relaunches per provider (`claude --resume <id>`, `codex resume <id>`, `copilot --resume=<id>`, see `buildAgentResumeInvocation`).
- `src/main/ghostty` + `src/main/pty` — Ghostty-class WebGL terminal rendering with scrollback persisted across restarts.
- Per-provider agent modules (`src/main/claude`, `codex`, `gemini`, `grok`, `pi`, …) plus `agent-hooks`, `usage`, and `rate-limits` for cross-vendor account/usage tracking.
- `src/main/ssh` — remote worktrees over SSH with auto-reconnect and port forwarding.
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

## Gap analysis against Caxri

_Researched 2026-09-26 from source `da6d483a` (desktop v1.4.197) and GitHub issue reactions. Web
evidence came from search snippets only; release dates were not verifiable._

- **Traction**: ~78.6k stars (repo created 2026-03-17), roughly daily releases, iOS on the App
  Store, Android APK. Reaction counts are low relative to stars (top issue ≈60), so read them as
  relative demand.
- **Core loop Caxri lacks**: Orca creates and removes the worktree itself (from a GitHub, GitLab,
  Linear, or Jira item, a branch, or a name), runs `orca.yaml` `scripts.setup` (trust-gated by
  content hash), and starts the chosen Agent with a prompt. Caxri only adopts a worktree after an
  Agent runs `git worktree add` (ADR 0001).
- **Agent breadth**: about 40 TUI agents plus "any CLI" versus Caxri's `claude`, `codex`, `grok`.
  Reviews cite bring-your-own-agent as a primary reason to choose Orca.
- **Review loop**: line and range diff comments are batched to the Agent, and AI attribution
  gutters mark agent-written lines. Source Control covers stage, commit, push, AI commit and PR
  text, create PR, and stacked PRs. Caxri Git writes stop at switch, sync, and discard.
- **Browser and Design Mode**: worktree-scoped Chromium with element grab (HTML, CSS, and a
  cropped screenshot into the prompt), plus a full agent-browser CLI surface (`orca tab …`,
  snapshot/click/fill). Also an iOS Simulator and Android emulator tab, and Computer Use sidecars.
- **Accounts**: usage and rate-limit tracking with a hot-swap account switcher. Open requests ask
  for multiple Claude subscriptions (#11557, 11 reactions) and auto-failover.
- **Remote**: SSH worktrees (relay deploy, port forwarding) and `orca serve` headless runtime.
  First-class headless mode (#4280, 25) remains the top open remote request.
- **CLI**: covers the full lifecycle (`worktree create --agent --prompt`, `terminal read/wait
  --for tui-idle`, browser, emulator, computer, linear, automations, orchestration DAG). The Caxri
  CLI has no project add, session create, worktree, or git commands.
- **Mobile**: push notifications (APNs/FCM via a push gateway), a vendor relay beyond LAN, an iOS
  terminal, permission/question cards, stage/commit/create PR, worktree creation from tasks,
  remote browser screencast, dictation, and multi-host. Caxri mobile is unreleased and defers push,
  approvals, and multi-host.
- **Orca's weak spots (openings)**: memory and CPU blowups (100+ GB reports, renderer OOMs) and
  daily-release regressions; editor intelligence (embedded VS Code #7754 28, LSP #3035 25, blame
  #9948 21); multi-repo workspaces (#1099 60, #7568 35, ≈170 reactions across 9+ issues); jj
  workspaces (#1082 40); relay reliability (#16238 16); workspaces not forced into new worktrees
  (#2654 12); WSL (#5311 13).

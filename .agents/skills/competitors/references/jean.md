# Jean (coollabsio/jean)

_Researched 2026-08-06._

_Long-paste behavior refreshed 2026-08-31 against commit `41390c6`._

- **Positioning**: "Opinionated" native desktop dev environment for AI agents: git worktrees, chat sessions, terminals, and GitHub/Linear integrations unified into one cohesive workflow; explicitly picks one workflow per decision ("git worktrees for isolation, automated merging, structured context loading") instead of exposing configuration.
- **Company/traction**: Built by coolLabs (makers of self-hosted PaaS Coolify), core maintainer Andras Bacsai; launched ~2026-01-23, ~1,134 GitHub stars / 134 forks / 123 open issues as of this research; sustained via GitHub Sponsors, Open Collective, and coolLabs' managed cloud services rather than a paid tier.
- **Tech stack**: Tauri v2 (Rust) + React 19 + TypeScript, Tailwind CSS v4, shadcn/ui v4, Zustand v5, TanStack Query, CodeMirror 6, xterm.js.
- **License**: Apache-2.0, free forever, no feature gates.

## Architecture highlights

- Hierarchy is Folder → Project → (Base session | Worktree → Session tabs); a base session works directly in the project's main directory/branch, while a Worktree is a branch-backed workspace with its own path and lifecycle (setup script results, PR linkage, issue/PR/security/Linear/Mr. Robot origin, archive state).
- Sessions carry their own UI/workflow state (model, backend, execution mode, approval state, recap digest, review results, pending permission requests) scoped to the owning worktree, avoids "smearing" context across unrelated tasks.
- "Linked Projects" let multiple repos (app/api/docs/SDK) share context in one session; agents are nudged to check linked repos' `CLAUDE.md`/`AGENTS.md`/`docs/`.
- Optional `jean-server` headless mode exposes the full UI over token-protected HTTP/WebSocket (default port 3456) for browser or native-app remote access; Tailscale recommended over public exposure.
- Backend-agnostic: wraps locally-installed CLIs (Claude CLI, Codex CLI, Cursor CLI, OpenCode, PI, Command Code, Grok, Kimi Code) with no vendor lock-in: user brings their own subscriptions/auth.

## Standout features

- "Magic Commands"/Magic Prompts: per-workflow AI actions (investigate issue/PR, code review with tracked findings, AI commit messages, PR content, merge-conflict resolution, release notes) each with its own configurable model/backend/effort.
- Mr. Robot (beta): polls open GitHub issues on a schedule, respects label filters and active-hours window, creates one worktree per issue with a drafted plan, and can optionally auto-approve ("yolo") ready plans.
- Deep GitHub/Linear integration: cross-project dashboard for issues/PRs/workflow runs/security alerts/advisories/Dependabot, "checkout PR as worktree," auto-archive worktree on PR merge.
- Multi-dock terminal (floating/left/right/bottom), diff viewer (unified & side-by-side), file tree with preview, token-usage debug panel, mobile swipe gestures, configurable keybindings/themes/fonts.
- Optional "Opinionated Plugins" for token reduction (RTK proxies CLI tool output, cutting 60-90% of tool-output tokens; Caveman trims Claude responses ~65-75%).
- Text pastes at or above 2,000 characters are saved as a local text attachment, and the chat input receives a short file-reference instruction instead of the original text. Jean does not call a model to summarize the paste; this provides a useful precedent for keeping large source text out of the immediate Agent prompt while retaining an exact local artifact.

## Community sentiment

- Named among agent workbenches tried by @T_Zahil in an X thread on 2026-08-05 (<https://x.com/T_Zahil/status/2085024540355166472>).
- Maintainer's own launch post (LinkedIn, 2026-02-11) frames it as a Conductor-inspired but more customizable alternative built after "needing some features for my open-source work"; early replies were enthusiastic, offering to test/contribute.
- Third-party review (aicoolies.com) is positive, calling it a "credible open-source option" for developers wanting a unified cockpit instead of tmux panes, and groups it competitively with Emdash, Conductor, Sculptor, and Superset.
- Recurring Linux packaging pain: multiple open GitHub issues report blank/frozen windows on Arch+Hyprland, Ubuntu, and Linux Mint AppImage builds due to missing GStreamer plugins / WebKit EGL failures; one commenter suggests Tauri's WebKit-on-Linux backend is the root cause and CEF would be more reliable, but Tauri doesn't yet support it. macOS is the only "tested" platform; Windows/Linux desktop builds are explicitly marked as needing more testing.

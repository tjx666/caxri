# Conductor (closed source)

_Researched 2026-08-06._

- **Positioning**: macOS "multi-agent IDE" for running several Claude Code, Codex, Cursor, and OpenCode agents in parallel, each in its own git-worktree-backed workspace, with a UI to review diffs, track checks, and open/merge pull requests. Explicitly framed as the workspace/orchestration layer on top of agent CLIs, not a replacement editor.
- **Company/traction**: Melty Labs (San Francisco), founded 2024, YC S24. Founders Charlie Holtz (CEO) and Jackson de Campos. Raised $22M Series A (Mar 30, 2026) from Matrix and Spark Capital, plus YC and Notion/Linear founders, after a Matrix-led seed. Reported 10x user growth since January 2026; used by engineers at Google, Meta, Amazon, Stripe, Spotify, HubSpot, Ramp, Datadog, and others. Launched a "Conductor Cloud" tier (cloud sandboxes that keep agents running after the laptop closes) in May 2026.
- **Tech stack**: Tauri 2.6.2 (Rust core + native WKWebView) wrapping a React 19 + TypeScript + Vite frontend (TanStack Router/Query, Zustand, react-virtuoso, xterm.js, Tailwind CSS, Radix UI). SQLite is the local source of truth; agent CLIs run as child processes under Bun (previously Node). macOS only; no Windows/Linux build as of this research.
- **License**: Closed source: no public GitHub repository; distributed only as a signed macOS app download.

## Architecture highlights

- One workspace = one git worktree + one checked-out branch; workspaces share the same underlying repo history/refs/object database, so creation is fast (no re-clone). Setup/run/terminal commands execute from the workspace's own working directory.
- Explicitly documents worktree isolation as "development isolation, not a security boundary": agents and commands still run with the user's own macOS permissions unless additional sandboxing is configured.
- `.worktreeinclude`-style "Files to copy" pattern brings gitignored local files (e.g. `.env.local`) into new workspaces; setup scripts handle dependency installs and other per-workspace prep. `CONDUCTOR_PORT` env var lets multiple concurrently-running workspaces claim separate dev-server port ranges.
- Checkpoints: before each agent turn, Conductor snapshots the working branch to a private Git ref (separate from normal history), enabling turn-level revert of both code and chat state.
- Conductor Cloud extends the same workspace model to hosted Linux sandboxes shared across an org, with a REST API (`api.conductor.build/v0`) to create/poll/message workspaces and sessions programmatically.
- Rewrote for performance in mid-2026 (per performance.dev): moved react-router to TanStack Router for stable references, virtualized the chat list, shimmed the Tauri `invoke()` bridge so the production React client could run in Chrome for real DevTools profiling.

## Standout features

- Native per-workspace agent chat/session views (no CLI TUI needed) alongside a live diff viewer, CI/PR "Checks" tab, and one-click PR creation/merge/archive per workspace.
- Multi-agent-per-workspace mode: several agents (e.g. implementer + reviewer + test-fixer) can share one branch/workspace when work needs shared context, distinct from the default one-workspace-per-task isolation model.
- Session steering (mid-turn follow-up messages), Plan Mode, and per-session "Fast Mode"/thinking-level controls.

## Community sentiment

- X thread, @T_Zahil, 2026-08-05 (<https://x.com/T_Zahil/status/2085024540355166472>): OP says they used only Conductor for 6+ months but recently soured on it after Conductor "introduced some changes I don't like" (its cloud-oriented pivot); a replier (@Moshe_Grunwald) still prefers it "cause I like the way it has workspaces and native agent views (don't need to use the cli tuis)."
- r/conductorbuild and LinkedIn reviews report real friction: broken `.env` copying into new worktrees, high battery/energy usage, terminal mouse-selection bugs, SSH-passphrase auth gaps, and startup crashes; one reviewer called onboarding "doing too much" while conceding "the worktree workflow has real potential."
- Other feedback (LinkedIn, Jan–Mar 2026) is more positive on the core UX: "so close to my dream UI for coding agents," workspaces plus multi-thread-per-workspace and "Fix CI" praised, while criticizing UI gimmicks (animated plan-mode indicators) and, separately, performance slowdowns after rapid feature shipping.

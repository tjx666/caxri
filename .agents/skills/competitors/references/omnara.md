# Omnara (omnara-ai/omnara)

_Researched 2026-08-06._

- **Positioning**: "Agent command center" / "control plane for agents": lets a developer start Claude Code (and Codex CLI) on their own machine and continue the same session from web or mobile, so a running agent never blocks on a human being at the terminal. Not a terminal workspace like Caxri/Kero/cmux; it is a remote-control and notification layer on top of CLI agents.
- **Company/traction**: YC S25 (Ishaan Sehgal, Kartik). Show HN launch (Sep 2025, ~310 points/168 comments) and a v2 Launch HN (~147 points/161 comments); 2,600+ GitHub stars; iOS/Android apps (4.7★, 42 reviews); pricing free up to 10 sessions/month, then $20/month unlimited (BYO Claude/Codex subscription).
- **Tech stack**: v2 (current, at omnara.com) is a Bun-executable headless daemon built on the Claude Agent SDK, running the agent loop directly rather than wrapping the CLI; outbound-only WebSocket relay to Omnara's server; optional cloud sandbox continuation with git-commit-per-turn sync. The archived v1 backend (`omnara-ai/omnara`) is Python/FastAPI + MCP server, PostgreSQL/SQLAlchemy + Alembic, Next.js web dashboard, React Native mobile app, Node.js CLI.
- **License**: Apache-2.0 for the `omnara-ai/omnara` repo (web dashboard + mobile app source); that repo was archived Feb 2026 as "no longer maintained" after migrating to the new closed-loop v2 platform, so current core daemon/backend licensing is unclear.

## Architecture highlights

- Relay model: a small headless daemon on the user's machine holds an authenticated outbound WebSocket to Omnara's server (no exposed ports, SSH, or tunneling needed); the server relays agent output/questions to web and mobile clients and routes user replies back.
- Session durability: conversation state persists server-side; if the local machine goes offline, Omnara can continue the agent in a hosted sandbox, git-committing each turn so work can later be pulled back locally: explicit crash/offline survival as a design goal.
- Unified messaging: v1's `messages` table (`sender_type`, `requires_user_input`) modeled agent questions and user feedback as one stream, read via MCP tools and REST side by side: a capability-detection-like pattern for surfacing "agent needs input" state.
- Multi-surface sync: same session mirrors across terminal (legacy CLI wrapper era), web dashboard, and mobile with instant handoff; v2 dropped 1:1 terminal mirroring in favor of a purpose-built GUI.

## Standout features

- Push notifications + one-tap approve/reject of diffs from mobile when an agent needs input, positioned against SSH/tmux-based remote setups (Vibetunnel, Termius) that lack this.
- Two-way voice mode for talking to the agent hands-free (commuting/walking), reported by the founders as unexpectedly high-value versus mobile typing.
- Orchestrator mode: spawn/coordinate parallel sub-agents from a single mobile dashboard; also supports git worktree-based parallel sessions.
- GitHub Actions integration: remote-trigger Claude Code runs from phone/dashboard with automatic PR creation, monitored through the same interface.

## Community sentiment

- Named alongside Caxri-adjacent tools in the OP's agent-workbench list on X (2026-08-05, <https://x.com/T_Zahil/status/2085024540355166472>).
- Two Hacker News launches were well received (Show HN ~310 pts/168 comments; Launch HN ~147 pts/161 comments); a vocal minority of early adopters said they "miss the old way" (1:1 terminal mirroring) after the v2 GUI-first rewrite dropped that fidelity.
- Compared favorably to competitor Happy Coder (slopus/happy) in HN discussion for reliability/latency, with commenters noting Happy appeared abandoned.
- Third-party review (revuo.ai) flags a real trade-off: the cloud relay lacks end-to-end encryption, and cloud-sandbox environment parity isn't always perfect for dependency-heavy local setups; overall sentiment scored "very positive."
- Google Play reviews (4.7★) are positive but note Android push notifications for "agent needs input" aren't yet native OS notifications, undercutting the core "never get blocked" pitch.

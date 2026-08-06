# T3 Code (pingdotgg/t3code)

_Researched 2026-08-06._

- **Positioning**: "Agent harness control surface" — a bring-your-own-subscription orchestrator that wraps installed provider CLIs (Claude Code, Codex, Cursor, Grok Build, OpenCode) behind unified web, Electron desktop, and native mobile (iOS/Android) clients, with first-class remote/multi-device control as the differentiator versus terminal-only harnesses.
- **Company/traction**: Built by Theo Browne (t3.gg) and ping.gg (lead maintainer `juliusmarminge`, plus `t3dotgg`); GitHub reports 16.8k stars, 3.8k forks, ~1.2k open issues; marketing site claims "tolerated by over 100,000 devs." Very early/alpha — README explicitly says "we are very very early... expect bugs" and is "mostly not accepting contributions."
- **Tech stack**: TypeScript/Node.js monorepo (Effect-based server), React web app, Electron desktop app, native mobile app; Effect RPC over WebSocket connects all clients to one Node server; SQLite (Node's experimental built-in) for server state; optional Tailscale integration and a hosted "T3 Cloud" relay (private beta) for remote pairing/notifications.
- **License**: MIT.

## Architecture highlights

- Single Node.js server (`apps/server`) is the sole execution boundary — every provider process, terminal, git operation, and filesystem read happens server-side, never in any client; web/desktop/mobile are thin clients sharing `packages/client-runtime` (connection supervisor, RPC session, Atom-based state) so they differ only in platform layer, not logic.
- Client/server contract is a typed Effect RPC group (`packages/contracts`) over one authenticated WebSocket (`/ws`); most interaction is via server-push subscriptions (`orchestration.subscribeThread`, `terminal.attach`, etc.) rather than a broadcast bus, with per-method scope authorization.
- Orchestration is event-sourced: client commands go through a durable `commandQueue`, are turned into events by a pure decider, and projections derive the read model — giving durable, replayable thread/turn history independent of any single client being connected.
- Domain model is Environment (a running server + filesystem + credentials) → Project (workspace rooted at a directory) → Thread (durable conversation/work history) → Turn (one user-to-agent cycle, including git checkpointing) → Activity (individual agent steps/tool calls).
- Provider driver registry integrates 5 built-in agent CLIs (Codex, Claude, Cursor, Grok Build, OpenCode) as separate transports/drivers behind the same orchestration engine; deep git integration automates worktree management, checkpointing, and diff generation per turn.

## Standout features

- True multi-device control: identical session state and live agent output reachable from web, desktop, and mobile apps (with Live Activities/push notifications via the hosted relay), not just a remote-viewer bolt-on.
- Durable, event-sourced thread/turn history means sessions and in-flight agent turns survive client disconnects and reattach cleanly from any device — closest analogue to Caxri's session-persistence goals but centralized in a always-on server process rather than per-window state.
- One-button "commit, push, PR" flow: every agent thread writes to its own branch, with auto-generated PR titles/bodies, inline diff review, and draft/stack/amend PR support built on the user's existing GitHub auth.
- Bring-your-own-subscription model (no token resale, no quota caps) plus explicit "fork the whole thing" ethos backed by MIT license.

## Community sentiment

- X thread by Thomas Sanlis (2026-08-05, https://x.com/T_Zahil/status/2085024540355166472) asking devs to compare agent-harness GUIs (Codex, Conductor, T3 Code, Orca, Synara, etc.) drew largely positive replies for T3 Code specifically: JoshuaRileyDev (https://x.com/JoshuaRileyDev/status/2085267002386444721) said its remote integration is good enough that he moved all iOS/web development to a spare Mac mini and works "fully remotely, it's magical"; VincentBuilds (https://x.com/VincentBuilds/status/2085054948329337147) rated Orca best "right now" but flagged T3 Code as a likely favorite "once they implement sub agent view."
- elan_chezhian94 (https://x.com/elan_chezhian94/status/2085258196487459084) called T3 Code and Clodex "the most polished ones" — Clodex for GPT models, T3 Code "for everything," praising update cadence and clean integration ("Codex copies the best ideas. T3 Code usually ships them first.").
- The OP (Thomas Sanlis) pushed back on that praise in a follow-up (same thread), saying he likes T3 Code's direction but finds "almost all of them are more polished (and mature) than T3 code," and elsewhere in the thread noted it "lacks a lot of features and has a poor UX sometimes" — consistent with the project's own "very early, expect bugs" framing.

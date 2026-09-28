# Mobile companion apps

_Researched 2026-08-31 (phase one), refreshed 2026-09-24 (phase two)._

Survey of mobile remote-control companions for terminal-native coding-agent tools, gathered while
scoping Caxri Mobile's phase-two design (live Terminal, conversation, and composer). The resulting
Caxri product decisions live in [docs/mobile/design.md](../../../../docs/mobile/design.md); this
file stays scoped to what the competitors did and how Caxri's design responded.

## What users value

Public posts on X from August and September 2026 about Orca, Paseo, T3 Code, Codex remote control,
and Claude Code Remote Control repeat four themes:

1. **Connection reliability and fast sync** decide sentiment. Codex remote is criticized mostly for
   disconnects and desync; T3 Code and Orca are praised mostly for staying connected.
2. **Starting work from the phone**, not only joining a Session started on the computer. Codex is
   praised for it; Claude Code Remote Control is criticized for join-only sessions.
3. **Knowing progress while away**, such as T3 Code's Live Activities.
4. **A native conversation UI** instead of SSH or a raw TUI, which is why Paseo and T3 Code are
   preferred for daily phone use.

Every React Native competitor ships a live Terminal: Orca, Muxy, and Superset embed xterm in a
WebView; Paseo draws a daemon-computed grid natively; T3 Code uses a libghostty native module.

## Public references

| Product                                                                   | Mobile direction                                                                                                                                | Caxri consequence                                                                             |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [T3 Code](https://github.com/pingdotgg/t3code/tree/main/apps/mobile)      | Most complete native companion: timeline, approvals, one-screen new task, per-turn diff review, native Terminal, Live Activities, tablet split. | Copy its foreground recovery rule and one-screen new Session; defer native rendering modules. |
| [Orca](https://github.com/stablyai/orca/tree/main/mobile)                 | xterm WebView Terminal with per-PTY mobile subscribers, transcript-derived chat, multi-host, docked panels on tablets.                          | Copy concurrent Desktop/mobile observation and the width plus short-side tablet rule.         |
| [Paseo](https://github.com/getpaseo/paseo/tree/main/packages/app)         | One Expo app for phone, web, and desktop; structured Agent timeline and approvals; native grid Terminal.                                        | Structured approvals need real request identity; defer them until hooks carry one.            |
| [Superset](https://github.com/superset-sh/superset/tree/main/apps/mobile) | Terminal-hosted Agents with a native composer that submits through the Terminal's Enter path.                                                   | Closest model to Caxri; copy the composer submission rule.                                    |
| [Muxy](https://github.com/muxy-app/mobile)                                | Remote terminal workspace with explicit pane take-over and release.                                                                             | Copy explicit take-over, but hold the resize lease on the Server.                             |
| Codex remote (ChatGPT app)                                                | Vendor relay, start-from-phone, Queue vs Steer, read-only Terminal stream.                                                                      | Starting a Session from the phone is core, not optional.                                      |
| Claude Code Remote Control                                                | Vendor relay, join-only sessions, two push toggles, no bypass modes from remote clients.                                                        | Keep notification toggles in mind for push; launch policy is enforced by Server Core.         |

LobeHub Mobile was also reviewed as an internal implementation reference. Proprietary repository
details are intentionally excluded from this public note. The reusable lesson is to keep native
dependencies behind testable boundaries and reserve real-device workflows for behavior that a Node
test environment cannot represent faithfully.

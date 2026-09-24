# Mobile Competitive Baseline

Research date: 2026-09-24. Phase one was researched on 2026-08-31.

## Decision

Phase one proved the secure pairing and attention loop: pair, see Sessions by attention, read a
bounded Terminal preview, send one short reply while the Agent waits, and revoke from Desktop.

Phase two makes the app a remote control that is useful away from the computer, over LAN and
Tailscale only. Its loop is: recover the connection quickly, read the Agent conversation, watch and
drive the live Terminal, send instructions or stop the Agent, start a new Session, and review the
changes. [DESIGN.md](DESIGN.md) owns the resulting UX contract.

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

## Architecture position

Caxri uses Expo SDK 57 and React Native 0.86.3, matching the newest public baseline above. The mobile
application depends on shared typed protocol and transport packages rather than reimplementing the
Server contract in UI code.

The LAN gateway is default-off and separate from Desktop's loopback control transport. Pairing links
expire after two minutes and are single-use. X25519 key agreement, the pairing secret, transcript-bound
HKDF keys, mutual confirmation, directional AES-256-GCM frames, monotonic counters, frame limits, and
device generation checks protect the connection. Resulting device credentials live in the operating
system secure store; pairing secrets remain in memory.

Every mobile mutation is re-authorized by Server Core. Project grants, device generation, Primary
Agent Terminal identity, waiting state, attention generation, control-character rejection, and the
1 KiB reply limit are checked immediately before PTY input. A stale or optimistic client cannot widen
its own authority.

## Testing and agent-debugging position

- Pure cryptography, frame replay protection, protocol projection, sorting, reconnect state, parsing,
  and policy checks run in Vitest without React Native mocks.
- The guarded Android acceptance test launches the real Desktop and Server with a fake Agent, pairs
  through the encrypted gateway, taps only stable `testID` controls, and proves the exact bounded PTY
  write and resulting state transition.
- Device receipts contain only stable identifiers, enabled/clickable flags, counts, and timings. They
  exclude visible copy, source, Terminal output, Agent transcripts, credentials, and environment data.
- Android and iOS native builds are both exercised locally. Android currently owns the automated
  interaction path because ADB offers explicit device selection and deterministic system control.
- Expo's experimental mobile debugging server is enabled during development. It is an optional aid,
  not a correctness dependency; the repository scripts and guarded acceptance remain the durable
  interface for any coding agent.

## Deliberate next gates

Phase two replaces the bounded preview and short reply with the live Terminal, conversation, and
composer described in [DESIGN.md](DESIGN.md). The gates below remain open.

1. Release-build startup and frame benchmarks on at least one Android phone-class device and one iOS
   simulator/device, with app-owned first-interactive instrumentation.
2. Sleep/wake, network handoff, and reconnect coverage before background notifications.
3. A device automation layer such as Maestro only when a second critical native workflow justifies
   another dependency and its installation is explicitly approved.
4. Push notifications after notification privacy, action authorization, token lifecycle, and delivery
   reliability are designed together.

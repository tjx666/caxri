# Mobile Competitive Baseline

Research date: 2026-08-31.

## Decision

Caxri phase one is a secure Agent Session companion, not a remote terminal or a reduced Desktop
workspace. Its complete user loop is:

1. Pair one mobile device with selected Projects.
2. See Sessions ordered by attention, running state, and recency.
3. Open a bounded read-only Terminal preview.
4. Send one short reply only while the Primary Agent is waiting on the same attention generation.
5. Revoke the device or disable the LAN gateway from Desktop.

This scope follows the strongest repeated mobile use case across Agent workbenches: check progress
and unblock an Agent away from the computer. Source control, file editing, arbitrary Terminal input,
workspace creation, and background notifications remain outside phase one.

## Public references

| Product                                                              | Current mobile direction                                                                                                           | Technical baseline                                                                                                                                                                       | Caxri consequence                                                                                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [T3 Code](https://github.com/pingdotgg/t3code/tree/main/apps/mobile) | A native companion in the main repository, with secure storage, camera pairing, and richer native Terminal/diff/Markdown surfaces. | Expo `~57.0.18`, React Native `0.86.3`, React `19.2.3` on 2026-08-31.                                                                                                                    | Match the current Expo and React Native generation, but defer native rendering modules until a narrower workflow proves they are needed. |
| [Orca](https://www.onorca.dev/docs/mobile)                           | Status, scrollback, and quick replies plus broader source-control, browser, command, and workspace features.                       | Its [mobile package](https://github.com/stablyai/orca/tree/main/mobile) used Expo `^55.0.30`, React Native `^0.83.10`, SecureStore, TweetNaCl, and an xterm-based surface on 2026-08-31. | Preserve the useful read-and-reply loop while avoiding a WebView Terminal and its larger authority and performance surface in phase one. |

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

1. Release-build startup and frame benchmarks on at least one Android phone-class device and one iOS
   simulator/device, with app-owned first-interactive instrumentation.
2. Sleep/wake, network handoff, and reconnect coverage before background notifications.
3. A device automation layer such as Maestro only when a second critical native workflow justifies
   another dependency and its installation is explicitly approved.
4. Push notifications after notification privacy, action authorization, token lifecycle, and delivery
   reliability are designed together.

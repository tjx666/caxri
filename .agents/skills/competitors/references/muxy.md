# Muxy (muxy-app/muxy)

_Researched 2026-08-06._

- **Positioning**: Lightweight native macOS terminal multiplexer organized around projects/worktrees, pitched as "a terminal that becomes a platform" via an extension SDK.
- **Company/traction**: ~1.9k stars, 50 contributors, weekly beta releases since 2026-03-31; iOS/Android companion apps; community-driven, no disclosed funding.
- **Tech stack**: Swift 6 / SwiftUI on libghostty; JS/TS extension SDK: extensions run in an isolated out-of-process `MuxyExtensionHost`.
- **License**: MIT.

## Architecture highlights

- Hook-based agent lifecycle detection (`working`/`waiting`/`finished`) over a versioned (v3) Unix-socket JSON protocol; authoritative over foreground-process detection, with grace windows (4s working, 30s waiting) to avoid premature idling.
- Declarative "verify and repair" reconciliation per agent provider (Claude, Codex, Cursor, Copilot, Droid, Grok, OpenCode, Pi): FSEvents-watches each provider's config, repairs drifted hooks in place, hashes its own writes to avoid self-triggering, rate-limits repairs.
- Duplicate-event suppression via a 256-entry FIFO of applied event IDs at the socket server.
- Backend-neutral "terminal surface contract": Ghostty is the only backend today, but search/snapshots/theming/image-paste are gated by capability protocols so a backend swap doesn't leak Ghostty specifics.
- Project/worktree/tab/split hierarchy plus an "Agents Focused" sidebar listing only active agent sessions.
- See `competitors/muxy/docs/features/ai-notifications.md` for the hook protocol.

## Standout features

- Extension marketplace/SDK; the same extension runs on iOS/Android companions.
- `muxy` CLI drives the whole workspace (open projects, split panes, send keys, read pane output) over a Unix socket, packaged as an installable "skill" for coding agents.
- Rich input panel with image attachments and voice input; 490+ themes; quick-terminal "dynamic island" overlay.

## Mobile companion

_Researched 2026-09-24 from `muxy-mobile` source `59c11e9` (2026-08-26)._

- Expo 54 / React Native 0.81 app mirroring the Mac workspace (Projects → worktrees → tabs and panes) in an xterm WebView over plain `ws://`, with Bonjour discovery or a QR code and Mac-side approval of each pairing.
- `takeOverPane` resizes the Mac PTY to the phone and releases it afterwards, with a short grace window (`src/state/usePaneSession.ts`). KeyBar with sticky modifiers and an arrow joystick.
- Git screens (commit, branches, worktree, PR, diff) and a file manager; no Agent chat or approval UI.

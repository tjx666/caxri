# Kero (egoist/kero)

_Researched 2026-08-10._

- **Positioning**: Calm, native macOS "terminal-centered project workspace": shells, file tree, Git diffs/panel, and a lightweight editor in one window so developers can supervise agent-written changes without a full IDE. Closest product shape to Caxri.
- **Company/traction**: Solo/small-team by egoist; v0.1.x, signed & notarized, free & open-source; modest early traction.
- **Tech stack**: Swift + AppKit (SwiftUI explicitly deprecated for runtime performance per their CLAUDE.md); libghostty default with optional Alacritty backend.
- **License**: GPL-3.0: reference-only for code.

## Architecture highlights

- `SessionStore.swift`: projects, tabs, and pane layout snapshot to disk; terminal panes restore as fresh shells in their last cwd with optional scrollback replay above a "Session Contents Restored" divider; file/diff panes reload from disk instead of snapshotting content.
- `GitStatusModel.swift`: event-driven (not polling) porcelain-v2 git status loader that rejects stale rows if the active terminal moves to a different repo mid-flight.
- `SessionInfoModel.swift`: polls `ps`/`lsof` to show live processes and listening TCP ports under a session's shell.
- `PRODUCT.md` codifies anti-goals: "avoid opaque one-click automation… controls that only work at generous panel widths": narrow-width usability as a design constraint.
- No telemetry; the only network call is the update check.

## Standout features

- Inline Git panel (stage/unstage/discard/commit/amend) beside the shell that produced the diff; inline diff viewer; branch operations from the sidebar.
- Session Info panel with processes + listening ports per session.
- OSC 9;4 progress-bar rendering above the terminal; Sparkle silent auto-update.
- Files supports inline create/rename, system Trash, and path remapping so open file tabs follow file or directory renames. Caxri should preserve the same recoverability and editor continuity while keeping mutation authorization in its isolated Runtime/Main boundary.

## Community sentiment

- deepakness.com review (2026-08-02) favors Kero over cmux for built-in files/git, but notes friction: no drag-to-reposition tabs, `cmd +/-` doesn't zoom text.
- Positioned by reviewers as the "more Mac-native alternative to Electron-heavy terminal workspaces": the direct performance-narrative competitor to Electron apps like Caxri.

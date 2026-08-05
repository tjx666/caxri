---
name: debug
description: Diagnose Caxri failures across Electron Main, secure Preload, React Renderer, utility-process Runtime, PTY, SQLite, file watcher, Git, and packaging boundaries. Use for crashes, blank windows, IPC failures, stale state, terminal lifecycle bugs, or packaged-only failures in this repository.
---

# Debug Caxri

1. Reproduce with the narrowest real process path; use `bun run dev` for interactive Electron behavior.
2. Identify the owner from `DESIGN.md`: Main for windows/dialogs, Renderer for UI, and Runtime for PTY/files/Git/SQLite.
3. Inspect structured Main and Runtime logs in repository `logs/` during development, or under the active Electron user-data directory for packaged/test launches. Compare correlation IDs and boundary timings; repeated Renderer requests may come from StrictMode, but must not duplicate expensive native work.
4. Trace the typed method and event through `src/shared/ipc`, Main, Preload, Runtime, and its Renderer consumer. Treat the selected Session root as a security and state-lifetime boundary.
5. Never print terminal output, file contents, credentials, or snapshots, and never weaken path containment to make a symlink error disappear.
6. Add a focused regression test at the lowest useful layer. Use Electron E2E when the process boundary is part of the failure.
7. Run `bun run lint`, `bun run typecheck`, and the focused test before the full relevant suite.

For native load failures, run `bun run spike:native` and `bun run spike:pty`, then verify the packaged app rather than assuming the development ABI matches.

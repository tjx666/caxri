---
name: debug
description: Diagnose Caxri failures across the headless Host, Electron Main, secure Preload, React Renderer, the Runtime child process, PTY, SQLite, file watcher, Git, and packaging boundaries. Use for crashes, blank windows, IPC failures, stale state, terminal lifecycle bugs, or packaged-only failures in this repository.
---

# Debug Caxri

1. Reproduce with the narrowest real process path; use `bun run dev` for interactive Electron behavior.
2. Identify the owner from the `project-architecture` skill's architecture reference: the headless Host for profile authority, the Desktop lease, and Runtime/SQLite lifecycle; Main for windows/dialogs as a replaceable Desktop client; Renderer for UI; and the Host-owned Runtime child for PTY/files/Git/SQLite services.
3. Inspect structured Host, Main, and Runtime logs in repository `logs/` during development, or under the active Electron user-data directory for packaged/test launches. Compare correlation IDs and boundary timings; repeated Renderer requests may come from StrictMode, but must not duplicate expensive native work.
4. Trace the typed method and event from its `packages/protocol` declaration (owner `host` or `desktop`) through the owning dispatcher, Preload, Runtime, and its Renderer consumer; `src/shared/ipc` is a compatibility re-export layer, not the schema source. Treat the selected Session root as a security and state-lifetime boundary.
5. Never print terminal output, file contents, credentials, or snapshots, and never weaken path containment to make a symlink error disappear.
6. Add a focused regression test at the lowest useful layer. Use Electron E2E when the process boundary is part of the failure.
7. Use the `quality-check` skill with the changed source and regression test before any broader suite.

For native load failures, run `bun run spike:native` and `bun run spike:pty`, then verify the packaged app rather than assuming the development ABI matches.

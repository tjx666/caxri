---
name: debug
description: Diagnose Caxri failures across the headless Host, Electron Main, secure Preload, React Renderer, the Runtime child process, PTY, SQLite, file watcher, Git, and packaging boundaries. Use for crashes, blank windows, IPC failures, stale state, terminal lifecycle bugs, packaged-only failures, or live CDP inspection of a running dev or production app in this repository.
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

## Live CDP inspection

Every unpackaged (dev) launch exposes CDP at `127.0.0.1:9223` (`CAXRI_DEV_CDP_PORT` overrides).
Packaged (production) builds expose the same endpoint by default during internal testing, so a
production-build issue can usually be inspected by connecting to the running installed app
directly; whether that suffices or a dev relaunch is still needed depends on the problem. The
`remoteDebugging` field in the Main-owned boot config `<userData>/config/argv.jsonc`
(Settings → "Remote debugging") turns the endpoint off on the next launch
(`src/main/remote-debugging.ts`).

Connect with `agent-browser`, always stripping proxy environment variables:

```bash
env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy \
  agent-browser connect 9223
```

The `env -u` prefix is mandatory on this machine: agent-browser honors `HTTP_PROXY`/`ALL_PROXY`
but ignores `NO_PROXY`, so a loopback CDP request gets routed into the local proxy, fails, and
the CLI silently prints `[agent-browser] relaunched browser` and attaches to its own
HeadlessChrome instead of Caxri. Verify the attachment before trusting any result:
`agent-browser eval "navigator.userAgent"` must report `caxri/... Electron/...`, not
`HeadlessChrome`. See <https://github.com/tjx666/caxri/issues/204>.

Known agent-browser 0.34.0 limitation: after connecting it only lists targets it created itself
(`about:blank`), not the app's existing main-window page target, and `tab --url` is unsupported.
When you need the real window, fall back to a raw CDP WebSocket: read the target list from
`http://127.0.0.1:9223/json/list`, open the page target's `webSocketDebuggerUrl`, and drive it
with `Runtime.evaluate` from a small Bun script.

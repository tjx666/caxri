---
name: debug
description: Diagnose Caxri failures across the headless Host, Electron Main, secure Preload, React Renderer, the Runtime child process, PTY, SQLite, file watcher, Git, and packaging boundaries. Use for crashes, blank windows, IPC failures, stale state, terminal lifecycle bugs, packaged-only failures, or live CDP inspection of a running dev or production app in this repository.
---

# Debug Caxri

1. Reproduce with the narrowest real process path; use `bun run dev` for interactive Electron behavior.
2. Identify the owner from the `project-architecture` skill's architecture reference: the headless Host for profile authority, the Desktop lease, and Runtime/SQLite lifecycle; Main for windows/dialogs as a replaceable Desktop client; Renderer for UI; and the Host-owned Runtime child for PTY/files/Git/SQLite services.
3. Inspect structured Host, Main, and Runtime logs together under the active runtime profile's `<userData>/logs/` directory. Compare correlation IDs and boundary timings; repeated Renderer requests may come from StrictMode, but must not duplicate expensive native work.
4. Trace the typed method and event from its owning `packages/protocol` domain through the Server dispatcher, Preload, and Renderer consumer. Treat the selected Session root as a security and state-lifetime boundary.
5. Never print terminal output, file contents, credentials, or snapshots, and never weaken path containment to make a symlink error disappear.
6. Add a focused regression test at the lowest useful layer. Use Electron E2E when the process boundary is part of the failure.
7. Call the Skill tool with "quality-check" with the changed source and regression test before any broader suite.

For native load failures, run `bun run spike:native` and `bun run spike:pty`, then verify the packaged app rather than assuming the development ABI matches.

For a macOS GPU incident, collect at most a 30-minute system window with:

```bash
bun run .agents/skills/debug/scripts/collect-macos-gpu-logs.ts \
  --start 2026-08-28T14:50:00+08:00 --end 2026-08-28T15:05:00+08:00
```

The script queries only Caxri's GPU helper, WindowServer, Dock, and kernel GPU/Metal/Space events. It emits bounded
signal enums and process metadata, never raw unified-log messages, paths, Terminal content, environment values, or
credentials.

## Live CDP inspection

Every unpackaged (dev) launch exposes CDP at `127.0.0.1:9223` and packaged (production) builds
expose `127.0.0.1:9224` (`CAXRI_DEV_CDP_PORT` overrides either), so an installed app and a dev
instance can run and be inspected concurrently. A production-build issue can usually be inspected
by connecting to the running installed app on 9224 directly; whether that suffices or a dev
relaunch is still needed depends on the problem. The
`remoteDebugging` field in the Main-owned boot config `<userData>/config/argv.jsonc`
(Settings → "Remote debugging") turns the endpoint off on the next launch
(`apps/desktop/src/main/runtime-profile.ts`).

Connect with `agent-browser`, always stripping proxy environment variables:

```bash
env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy \
  agent-browser connect 9223   # 9224 for a packaged (production) app
```

The `env -u` prefix is mandatory on this machine: agent-browser honors `HTTP_PROXY`/`ALL_PROXY`
but ignores `NO_PROXY`, silently prints `[agent-browser] relaunched browser`, and attaches to
its own HeadlessChrome instead of Caxri. Fixing proxy rules does not help — the local proxy
already forwards loopback traffic (verified: `curl -x http://127.0.0.1:7890` and
`-x socks5://...` both reach `/json/version`), and agent-browser still fails with only
`HTTP_PROXY` set, so the breakage is inside agent-browser's own proxy handling (most likely the
CDP WebSocket leg). Stripping the variables is the only reliable workaround. Verify the
attachment before trusting any result: `agent-browser eval "navigator.userAgent"` must report
`caxri/... Electron/...`, not `HeadlessChrome`. See
<https://github.com/tjx666/caxri/issues/204>.

With proxy variables stripped, agent-browser 0.34.0 attaches fully to the app's existing main
window: `tab` lists the real Caxri page target and `eval`/`screenshot` run against it directly
(verified against a packaged 0.0.13 app), so prefer agent-browser over hand-rolled CDP. Only if
attachment misbehaves (e.g. the UA check above fails), fall back to a raw CDP WebSocket: read
the target list from `http://127.0.0.1:9223/json/list` (9224 for production), open the page
target's `webSocketDebuggerUrl`, and drive it with `Runtime.evaluate` from a small Bun script.

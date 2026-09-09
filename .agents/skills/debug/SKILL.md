---
name: debug
description: Diagnose Caxri failures across Desktop Main, Server Core, Terminal Host, Extension Host, secure Preload, React Renderer, PTY, SQLite, file watcher, Git, and packaging boundaries. Use for crashes, blank windows, IPC failures, stale state, terminal lifecycle bugs, packaged-only failures, stopping a launched unpackaged instance, verifying Server freshness, visual UI confirmation, or live CDP inspection of a running dev or production app in this repository.
---

# Debug Caxri

1. Reproduce with the narrowest real process path. For interactive Electron behavior, agents always
   use `bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev` so the checkout owns
   an isolated profile and Desktop lease. Bare `bun run dev` is only a first-clone convenience for a
   human working outside an agent session.
2. Identify the owner from the `project-architecture` skill's architecture reference: Desktop Main
   for windows, dialogs, the Desktop lease, and the runtime profile; Server Core for Projects,
   Sessions, SQLite, settings, and the public command surface; Terminal Host for PTYs; Extension
   Host for native ESM extensions; Preload for the typed bridge; Renderer for UI. Frozen public
   identifiers such as `host.stop` are compatibility names, not current owners.
3. Inspect structured Desktop Main, Server Core, Terminal Host, and Extension Host logs together
   under the active runtime profile's `<userData>/logs/` directory. Compare correlation IDs and
   boundary timings. Repeated Renderer requests may come from StrictMode, but must not duplicate
   expensive native work.
4. Trace the typed method and event from its owning `packages/protocol` domain through the Server
   dispatcher, Preload, and Renderer consumer. Treat the selected Session root as a security and
   state-lifetime boundary.
5. Never print terminal output, file contents, credentials, or snapshots. Apply `AGENTS.md`'s
   trusted workspace-link policy when diagnosing file navigation; preserve the boundary against
   arbitrary outside paths instead of rejecting every external link target.
6. Add a focused regression test at the lowest useful layer. Use Electron E2E when the process
   boundary is part of the failure.
7. Call the Skill tool with "quality-check" with the changed source and regression test before any
   broader suite.

## Controlled real-Agent debugging

When a fake Agent cannot reproduce a provider-owned PTY or input-protocol behavior, debugging may
launch one explicitly selected real Codex process. This is a diagnostic exception, not permission for
ordinary E2E, CI, or Acceptance to discover or invoke a host provider.

- Use an isolated profile or an already authorized Project, the narrowest read-only sandbox
  available, no approval prompts, and one predeclared bounded input. Do not automate or persist a
  provider trust decision merely to create a temporary Project; fence an existing Project with
  before/after session identities instead. Never fall back to another provider.
- Do not read, screenshot, record, print, or persist Terminal output, prompts, responses, or Agent
  transcripts. Observe only content-free signals such as exact input bytes, process lifecycle,
  provider turn state, structured status events, and exit status.
- Stop every process started by the probe, interrupt any submitted turn, and remove exact diagnostic
  sessions or temporary state without touching unrelated user sessions.
- Treat the result as debugging evidence. Automated coverage still uses deterministic fake fixtures;
  Acceptance still proves the product surface without invoking a host provider.

## Runtime profile, shutdown, and visual proof

Unpackaged (dev) launches default to an isolated `caxri-dev` userData profile (own Server, SQLite,
and logs) so they never contend with the installed production app. `CAXRI_USER_DATA_DIR` overrides
it (`apps/desktop/src/main/desktop-profile.ts`).

Stop every dev instance you started before reporting a request complete, and verify it actually
died. One launch leaves five separate processes: the `electron-vite dev` launcher, the Electron
window process (whose `ps` command is `Caxri Dev`, not an Electron binary path), and the detached
`<worktree>/apps/server/dist/server/bundles/server-core.js` and `extension-host.js`.
`pkill -f "Electron.app/Contents/MacOS/Electron"` silently misses the window process, and the
launcher can outlive the signal. Never trust `pkill`'s exit code. Confirm with
`ps -axo pid,command` plus a CDP probe of `127.0.0.1:9223`, then kill the surviving PIDs
directly. Match on the absolute `<worktree>/apps/server/dist/server/` path so a sibling
worktree's session and the installed `/Applications/Caxri.app` are never hit.

The dev Server Core and Extension Host are long-lived background processes that survive window
restarts. The Desktop replaces a Server whose build fingerprint differs from its own on connect,
but that only triggers when a window reconnects — a headless Server can still serve stale code
between launches. Before using a live instance to verify or disprove a Server change, confirm
the `apps/server/dist/server/bundles/server-core.js` and `extension-host.js` process start times
postdate the change (`ps -axo pid,lstart,command`), and restart them when they do not.

A user-visible Renderer/UI change is not done until it has been verified visually in the running
dev app. Drive the real application over CDP, capture a screenshot of the affected surface, and
check it before reporting completion. Passing unit or e2e gates alone does not count for visual
changes.

For native load failures, run `bun run spike:native` and `bun run spike:pty`, then verify the
packaged app rather than assuming the development ABI matches.

For a macOS GPU incident, collect at most a 30-minute system window with:

```bash
bun run .agents/skills/debug/scripts/collect-macos-gpu-logs.ts \
  --start 2026-08-28T14:50:00+08:00 --end 2026-08-28T15:05:00+08:00
```

The script queries only Caxri's GPU helper, WindowServer, Dock, and kernel GPU/Metal/Space events.
It emits bounded signal enums and process metadata, never raw unified-log messages, paths, Terminal
content, environment values, or credentials.

## Live CDP inspection

Every unpackaged (dev) launch exposes CDP at `127.0.0.1:9223` and packaged (production) builds
expose `127.0.0.1:9224` (`CAXRI_DEV_CDP_PORT` overrides either), so an installed app and a dev
instance can run and be inspected concurrently. A production-build issue can usually be inspected
by connecting to the running installed app on 9224 directly; whether that suffices or a dev
relaunch is still needed depends on the problem. The `remoteDebugging` field in the Main-owned boot
config `<userData>/config/argv.jsonc` (Settings → "Remote debugging") turns the endpoint off on
the next launch (`apps/desktop/src/main/desktop-profile.ts`).

Connect with `agent-browser`, always stripping proxy environment variables:

```bash
env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy \
  agent-browser connect 9223   # 9224 for a packaged (production) app
```

The `env -u` prefix is mandatory on this machine: agent-browser honors `HTTP_PROXY`/`ALL_PROXY`
but ignores `NO_PROXY`, silently prints `[agent-browser] relaunched browser`, and attaches to its
own HeadlessChrome instead of Caxri. Fixing proxy rules does not help — the local proxy already
forwards loopback traffic (verified: `curl -x http://127.0.0.1:7890` and `-x socks5://...` both
reach `/json/version`), and agent-browser still fails with only `HTTP_PROXY` set, so the breakage
is inside agent-browser's own proxy handling (most likely the CDP WebSocket leg). Stripping the
variables is the only reliable workaround. Verify the attachment before trusting any result:
`agent-browser eval "navigator.userAgent"` must report `caxri/... Electron/...`, not
`HeadlessChrome`. See <https://github.com/tjx666/caxri/issues/204>.

With proxy variables stripped, agent-browser 0.34.0 attaches fully to the app's existing main
window: `tab` lists the real Caxri page target and `eval`/`screenshot` run against it directly
(verified against a packaged 0.0.13 app), so prefer agent-browser over hand-rolled CDP. Only if
attachment misbehaves (e.g. the UA check above fails), fall back to a raw CDP WebSocket: read the
target list from `http://127.0.0.1:9223/json/list` (9224 for production), open the page target's
`webSocketDebuggerUrl`, and drive it with `Runtime.evaluate` from a small Bun script.

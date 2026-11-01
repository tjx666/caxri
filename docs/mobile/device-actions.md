---
kind: living
status: current
---

# Mobile device actions

`caxri device` lets a person or an Agent act on the phone paired with this Desktop: open a link on
it, or run a command in [Termux](https://github.com/termux/termux-app) on an Android phone. The
phone does the work and reports back; Server Core only relays.

```bash
caxri device list --json
caxri device open https://example.com/page
caxri device exec -- uname -a
caxri device exec --cwd ~/project --timeout 120000 -- sh -c 'git pull && make'
```

## Commands

| Command                                       | Method                        | Result                                                    |
| --------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| `device list`                                 | `mobile.deviceAction.targets` | Every paired phone with `online` when it can take actions |
| `device open [--device <id>] <url>`           | `mobile.deviceAction.openUrl` | `{deviceId}` once the phone opened the link               |
| `device exec [--device <id>] [--cwd] -- argv` | `mobile.deviceAction.exec`    | `{deviceId, exitCode, stdout, stderr, truncated}`         |

- With one connected phone, `--device` is optional; with several, the request fails with
  `VALIDATION` (`details.reason: ambiguous-target`) and lists their IDs.
- A phone is online only while Caxri Mobile is connected and in the foreground. Nothing is queued:
  an offline phone fails the request at once with `UNAVAILABLE` (`details.reason: offline`), and so
  does a phone whose connection closes before it answers.
- `device exec` prints the command's stdout and stderr as its own and exits with the command's exit
  code. With `--json` (an Agent's default) it prints the whole result and exits `0`.
- `--timeout` is the command's deadline (default 15 s, at most 10 minutes). The phone runs the
  command under coreutils `timeout`, so a deadline really stops it; that ends as `TIMEOUT`
  (`details.reason: timeout`). A command that itself exits 124 reads the same way.
- Each output stream is cut to 20,000 JSON-encoded UTF-8 bytes, keeping its start, so the result fits
  one Mobile frame; `truncated` says whether either stream was cut (by Caxri or by Termux itself).

All three methods need the `devices.control` capability, held by the human CLI and, by default, by
every Agent Endpoint. They are core-routed control methods that settle outside the connection's
ordered lane, since an `exec` may wait minutes.

## How an action reaches the phone

```text
caxri device exec ─► Server Core DeviceActionBroker ─► deviceActions subscription event
                                                      (deviceAction.requested {actionId, action})
phone runs it ─► mobile.deviceAction.complete {actionId, outcome} ─► broker resolves the CLI request
```

The phone subscribes `{kind:'deviceActions'}` (see [transport](transport.md#application-frames)) while it
is connected and in the foreground. `DeviceActionBroker`
(`apps/server/src/core/mobile/gateway/device-actions.ts`) gives each action an
`action_<32 hex>` ID, delivers it on the newest socket of the target phone, and waits for the
answer: for `exec`, the command deadline plus 5 s, so the phone's own `timeout` answer normally wins;
for `openUrl`, 15 s. An answer from another device or for a settled action is ignored. At most 16
actions are pending at once.

Every paired role may answer with `mobile.deviceAction.complete`: the action runs on the phone itself
and reads no Desktop data.

## On the phone

`openUrl` follows the phone's own link rule: a web page opens in the in-app browser, any other scheme
in the app Android or iOS assigns; a refused link answers `open-failed`.

`termuxExec` runs only on Android, through the local Expo module `apps/mobile/modules/caxri-termux`.
It sends Termux's `RUN_COMMAND` intent in the background, so Termux's UI never opens, and receives
the result through a `PendingIntent`. It needs all of:

1. Termux from [GitHub](https://github.com/termux/termux-app/releases) or F-Droid. The Google Play
   build has no `RUN_COMMAND` service.
2. `allow-external-apps=true` in Termux's `~/.termux/termux.properties` (then
   `termux-reload-settings`). Otherwise Termux refuses and the CLI sees `termux-error` with Termux's
   own message.
3. **Settings › This device › Termux commands** turned on. It is off by default; turning it on asks
   Android for Termux's `com.termux.permission.RUN_COMMAND` permission. Opening links needs no
   setting.

A failure carries one closed reason the CLI maps to an error code: `disabled` (`FORBIDDEN`),
`unsupported` and `termux-missing` (`UNAVAILABLE`), `permission-denied` (`FORBIDDEN`),
`termux-error` and `open-failed` (`IO`), `timeout` (`TIMEOUT`).

## Diagnostics

Server Core logs `mobile_gateway.device_action` for every action with its `kind`, how it ended
(`opened`, `exited`, `failed` with the phone's `reason`, or `no-listener`, `ambiguous-target`,
`disconnected`, `answer-timeout`), and `durationMs`. It never logs the URL, the command, or its
output.

---
kind: living
status: current
---

# Remote SSH

Desktop can open a window whose Projects, Terminals, and Agents run on an **SSH Host**: a Linux
machine reached with the user's own OpenSSH configuration. The SSH Host runs the same standalone
Server artifact Desktop supervises locally, so Files, Git, Search, Diff, Attention, and Agent hooks
behave as they do on this machine. [ADR 0014](adr/0014-ssh-remote-server.md) records why.

## Using it

- **Connect**: Project > Connect to SSH Host… (or the command palette). The dialog lists `Host`
  aliases from `~/.ssh/config` (wildcard patterns are skipped), recently connected destinations, and
  accepts a typed `user@host[:port]`. A destination starting with `-` is refused.
- **Window**: each SSH Host gets one window titled `SSH: <destination>`. Connecting to a destination
  that already has a window focuses it. The status bar shows the SSH Host; while connecting, an
  overlay names the current phase (connecting, probing, installing, starting, forwarding).
- **Prompts**: passwords, key passphrases, 2FA codes, and new host-key confirmations appear as a
  dialog inside that window. Answers go straight to OpenSSH and are never logged.
- **Reconnect**: a dropped connection retries with backoff. A failure that needs the user
  (authentication, a changed host key, a cancelled prompt) stops retrying and shows a Reconnect
  button; the same action is the `Reconnect to SSH Host` command.
- **Close and quit only detach.** The SSH Host keeps its Terminals and Agents. The Server there
  exits through the normal idle exit ([ADR 0010](adr/0010-server-core-idle-exit.md)), which waits
  while any PTY is live, or when the user runs **Stop Server on SSH Host**, which ends every
  Terminal and Agent on that machine and closes the window.
- **Settings**: on the first connect to an SSH Host, the local `settings.jsonc`, `keybindings.jsonc`,
  and `theme.json` are copied into the remote profile when it has none. After that the SSH Host's
  configuration is its own; Desktop never overwrites an existing remote file.

### What a remote window cannot do

Actions that would act on this computer's disk or OS are hidden or refused in a remote window,
because a remote path that happens to exist locally is a different file. The Main side enforces this
with one exhaustive per-method table (`apps/desktop/src/main/environment-method-policy.ts`); the
Renderer hides the matching commands through the `localMachine` command condition.

| Refused or hidden                                         | Remote replacement                    |
| --------------------------------------------------------- | ------------------------------------- |
| Native folder picker when adding a Project                | Folder browser served by the SSH Host |
| Move to Trash, Reveal in Finder, open with default app    | None yet                              |
| Open in external editor                                   | None yet                              |
| Theme import, diagnostics export, bug report, OS settings | Use the local window                  |

## Requirements on the SSH Host

- Linux x64 or arm64 with glibc 2.28 or newer (Debian 10, Ubuntu 18.10, RHEL 8 and later). An
  older glibc, musl (Alpine), macOS, or Windows host fails with a clear `unsupportedGlibc` or
  `unsupportedPlatform` reason.
- `sh`, `tar`, `gzip`, `base64`, and `sha256sum` (or `shasum`). A missing tool fails with
  `missingTool`. `curl` or `wget` with internet access is optional: without them, Desktop streams the
  Node runtime over SSH (slower, about 120 MB once).
- Agent CLIs (Claude Code, Codex, Grok) installed and logged in on the SSH Host. Caxri does not
  manage remote credentials.
- On hosts whose `systemd-logind` sets `KillUserProcesses=yes`, the Server dies with the last SSH
  session unless lingering is enabled for the user: `sudo loginctl enable-linger "$USER"`.

## Remote layout

Everything lives under `~/.caxri-server/` on the SSH Host:

| Path                 | Contents                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| `runtimes/<sha256>/` | The Node runtime, cached by content hash and shared by every build      |
| `builds/<buildId>/`  | One application layer: bundles, natives, and a hard link to its runtime |
| `profile/`           | The SSH Host Server's profile (database, config, logs, manifest)        |
| `install.lock/`      | Held while an install or garbage collection runs                        |

An install uploads only the application layer (about 5 MB gzip), checks its `SHA256SUMS`, and renames
it into place, so a partial upload never becomes a build. The two most recent builds are kept; a build
a running Server uses is never removed.

## How Desktop reaches it

Main starts one OpenSSH ControlMaster per SSH Host window, with its socket in a private
`/tmp/caxri-ssh-<uid>/` directory, and runs every probe, install, launch, and stop through it. The
remote Server listens on loopback only; Main adds `ssh -O forward -L` to it and rewrites the Server
manifest's endpoint to the local forward, so the WebSocket clients, Desktop credential handshake, and
Desktop lease are the local code paths. Each SSH Host window has its own `DesktopServerConnection`,
event relay, IPC transport, and Main method handler, and Main routes Renderer IPC by the sending
`WebContents`, so no request or event crosses environments. The code lives in
`apps/desktop/src/main/ssh/`, `apps/desktop/src/main/remote-environments.ts`, and
`apps/desktop/src/main/remote-environment-window.ts`.

The askpass helper is Desktop's own executable run as Node (`ELECTRON_RUN_AS_NODE`). It forwards the
prompt over a token-authenticated Unix socket to Main, which shows it in the window.

Typical timings against a container on the same machine: a cold install 3 to 4 s (5 s when the
runtime is streamed), attaching to an already running Server about 150 ms, a reconnect under 200 ms,
and upgrading to a new build under 1 s.

## Diagnostics

Structured log events live under `logEventCatalog.remoteSsh` (`remote_ssh.*` in Main's log): phase
transitions with durations, the probe result, install source, ControlMaster lifetime, forward setup,
attach failures with a closed `RemoteFailureReason`, and askpass outcomes. Records never carry the
destination, a prompt answer, or remote file contents. The SSH Host Server's own logs stay in
`~/.caxri-server/profile/logs/` on that machine.

## Building the remote layers

`bun run build:remote-layers` writes `apps/server/dist/remote/linux-{x64,arm64}/` (an `app.tar.gz`
and its `descriptor.json`). `bun run package` runs it first and ships the result as
`Contents/Resources/remote`; unpackaged dev builds read `apps/server/dist/remote` directly, so run it
once before connecting from a dev instance.

The Linux native addons (`better-sqlite3`, `node-pty`) are compiled in a `manylinux_2_28` Docker
container so they honor the glibc floor. Without Docker, point `CAXRI_LINUX_NATIVES_DIR` at addons
exported elsewhere with
`bun run apps/server/scripts/linux-target.ts export-natives --output <dir>`; the release workflow's
`linux-natives` job does exactly this on Linux runners. A stale export fails the build instead of
falling back.

## Testing

Unit tests sit beside the code under `apps/desktop/src/main/ssh/__tests__/` and
`apps/desktop/src/main/__tests__/`. The integration suite drives a real `sshd` container and is
opt-in:

```bash
CAXRI_SSH_INTEGRATION=1 CAXRI_SSH_CONFIG=<lab>/ssh_config \
  bunx vitest run apps/desktop/src/main/ssh/__tests__/
```

`CAXRI_SSH_CONFIG` makes Main pass `-F <file>` to every `ssh` call, so a disposable lab key and
config never touch the developer's own `~/.ssh`. The same variable works for a dev instance.

## Known gaps

- Trash, Reveal, open with the default app, and external editors have no remote equivalent yet;
  Agent Chat undo of a created file relies on Trash.
- `ProxyJump` and `ProxyCommand` should work through OpenSSH but have no automated coverage.
- A wrong key passphrase is asked again by OpenSSH up to its own retry limit.
- Remote stack traces carry no source maps (they are dropped from the remote layer to keep it small).

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
  accepts a typed `user@host[:port]`. A destination starting with `-` is refused. Its Open SSH
  Config action shows that file in Finder (its folder when the file does not exist yet).
- **Window**: each SSH Host gets one window titled `SSH: <destination>`. Connecting to a destination
  that already has a window focuses it. Destinations are compared by the `user@hostname:port` that
  `ssh -G` resolves, so two `~/.ssh/config` aliases for the same account share one window, and the
  focused window says so in a notification; when `ssh -G` fails, the typed spelling decides. The
  status bar shows the SSH Host, and clicking it opens Stop Server on SSH Host…, Connect to SSH
  Host…, and Close Window. While connecting, an overlay names the current phase (connecting,
  checking the SSH Host, installing, starting, or reconnecting with its attempt number) and offers
  Cancel, which stops the attempt and keeps the window open on a cancelled state.
- **Prompts**: passwords, key passphrases, 2FA codes, and new host-key confirmations appear as a
  dialog inside that window. Answers go straight to OpenSSH and are never logged. When OpenSSH asks
  the same password or passphrase again within one attempt, it rejected the previous answer, so the
  dialog says so and numbers the attempt. Cancel or Escape ends the attempt at once (a click outside
  the dialog does not): OpenSSH would otherwise treat each refused prompt as one failed try and keep
  asking.
- **Reconnect**: a dropped connection retries with backoff, and the overlay keeps showing the cause
  while it does. A failure only the user can resolve (authentication, a changed host key) or a
  cancel stops retrying and shows a Reconnect button; the same action is the `Reconnect to SSH Host`
  command. A host that fails Caxri Server's requirements (platform, glibc, a missing tool) offers
  only Close Window, because reconnecting would fail the same way. Copy Details copies OpenSSH's or
  the SSH Host's own message, and a changed host key adds Copy Command for the `ssh-keygen -R`
  command that removes the stale `known_hosts` entry.
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

| Refused or hidden                                         | Remote replacement                      |
| --------------------------------------------------------- | --------------------------------------- |
| Native folder picker when adding a Project                | Folder browser served by the SSH Host   |
| Move to Trash                                             | The SSH Host's freedesktop.org Trash    |
| Open File by Path outside the Project, or `~`             | Paths inside the remote Project only    |
| Reveal in Finder, open with default app                   | None yet                                |
| Open in external editor                                   | None yet                                |
| Theme import, diagnostics export, bug report, OS settings | Use the local window                    |
| Cite a file dropped from Finder or picked with `+`        | Drop it from Files; images still attach |

Move to Trash, including Agent Chat undo of a file the Agent created, keeps the same native
confirmation. After it, the remote Server moves the entry into the SSH Host's home Trash
(`$XDG_DATA_HOME/Trash`, by default `~/.local/share/Trash`) with a `.trashinfo` record, so `gio trash
--restore` or a desktop file manager on that machine can recover it. The Server rechecks the
device and inode the user approved, so a path replaced after the dialog is refused. A Project on
another filesystem than the home directory is copied into the Trash and then removed.

Open File by Path (Cmd+P) browses, searches, and opens files inside the Session's remote Project. It
identifies each directory through the remote Server's `files.authorizeOpen` instead of this Mac's
`lstat`, so an absolute path typed into it stays a Project path: one inside the Project opens, one
outside it is refused. Free browsing outside the Project, `~`, and the Backspace gesture that
detaches from the Project are not offered, because they would list this Mac's disk.

A file path a Terminal prints opens the same way when it resolves inside a Project. A path outside
every Project is refused with a message asking the user to add its folder as a Project, because the
local window's external-file snapshot would read this Mac's disk.

## Requirements on the SSH Host

- Linux x64 or arm64 with glibc 2.28 or newer (Debian 10, Ubuntu 18.10, RHEL 8 and later). An
  older glibc, musl (Alpine), macOS, or Windows host fails with a clear `unsupportedGlibc` or
  `unsupportedPlatform` reason.
- `sh`, `tar`, `gzip`, `base64`, and `sha256sum` (or `shasum`). A missing tool fails with
  `missingTool`. `curl` or `wget` with internet access is optional: without them, Desktop streams the
  Node runtime over SSH (slower, about 120 MB once).
- Agent CLIs (Claude Code, Codex, Grok) installed and logged in on the SSH Host. Caxri does not
  manage remote credentials.
- A home directory shared between hosts (NFS on cluster login nodes, for example) holds one
  profile, so only one of those hosts runs a Server at a time. The Server on the other host refuses
  to start and the window fails with `profileInUse`, naming the host that holds it. The owner renews
  a lease in `profile/host/host-lease.json` every 15 s; once it stops renewing for 60 s (it exited
  or crashed), another host takes over. The hosts' clocks must agree to within that margin.
- On a machine shared by several accounts, the Server's single-instance lock is an abstract Unix
  socket whose name derives from `profile/host/lock-secret` (mode 0600), so other accounts cannot
  predict it. A name another account binds (it can see names in `/proc/net/unix` once they were
  used) is skipped for the next one in a series of 64, logged as `server_core.profile_lock_squatted`.
  If every name is taken, the window fails with that reason instead of a generic start failure.
- File watching uses inotify, which charges one watch per watched directory against
  `fs.inotify.max_user_watches`, shared by every program the account runs. A large Project, or
  another watcher such as an editor's language server, can exhaust it (Debian and Ubuntu default to
  8192 on older kernels). The affected watch then falls back to polling, so the file tree and Git
  status lag by a few seconds, and the window shows a persistent warning with a Copy command button
  for the fix: `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p`
  The Server retries native watching with backoff (up to every 5 minutes), switches back without a
  reconnect once the limit allows it, and removes the warning. `watch_hub.fallback` records the
  cause as a closed `reason` (`watch-limit`, `instance-limit`, or `other`).
- The account's inotify instances (`fs.inotify.max_user_instances`, often 128) are a second limit:
  every watching program holds one. `@parcel/watcher` 2.6.0 hangs instead of failing when it cannot
  create one, so before the Server's first native watch it checks from a short-lived child process
  that an instance can still be created. If not, watching starts in polling mode with the same kind
  of warning, offering `fs.inotify.max_user_instances=512`, and the check repeats on each retry.
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

Periodic `/tmp` cleanup does not break a live connection: macOS's cleaner removes only regular files, and
`systemd-tmpfiles` skips sockets in use, so the ControlMaster socket survives as long as its
master runs.

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
falling back. Running the Release workflow manually on `main` (`gh workflow run release.yml --ref
main`) runs only that job, to rehearse the natives build before a release depends on it.

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

`CAXRI_SSH_DESTINATION` picks the lab host (default `caxri-lab`). Pointing it at a host reached
through `ProxyJump` (a second `sshd` container only reachable from the jump container) runs the whole
suite, askpass prompts included, through the jump host. The target's `sshd` log shows each login
coming from the jump container's address, which proves the traffic did not bypass the hop.

## Known gaps

- Reveal, open with the default app, and external editors have no remote equivalent yet.
- Remote stack traces carry no source maps (they are dropped from the remote layer to keep it small).
- A directory created after a watch started, while the inotify limit is already exhausted, is
  silently left unwatched: `@parcel/watcher` drops it without reporting an error, so no warning
  appears and changes inside it show up only after Refresh in the Files view.

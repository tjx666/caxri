---
kind: adr
status: accepted
---

# SSH Hosts run their own Server; Desktop reaches it through system OpenSSH

- Date: 2026-10-12
- Refs: issue #1885
- Amends: [ADR 0007](0007-remote-access-and-project-authorization.md) (adds an SSH access path beside local, direct, and Relay)

Developers run Agents on Linux machines they reach over SSH. A remote Agent must survive the laptop sleeping or the
network dropping, and the remote Session must keep Attention, Files, Git, Search, and Diff parity with a local one.
Only a process on the remote machine can own those PTYs and watchers, so the SSH Host runs the same standalone Server
artifact Desktop already supervises locally (ADR 0004), under its own profile there.

**Decision**: Desktop connects to an SSH Host with the user's system OpenSSH client and `~/.ssh/config`, installs a
Server artifact built from the same bundles as its local one, starts it detached on the remote loopback interface, and
attaches to it exactly like a local Server. Everything above the transport is unchanged.

- **Transport**: one ControlMaster connection per SSH Host, owned by Main, under a private control directory. Every
  other SSH invocation (probe, install, launch, stop, port forward) multiplexes over it, so the user authenticates once.
  Main adds a loopback port forward to the SSH Host Server's loopback endpoint through the master
  (`ssh -O forward -L`). Desktop then reads a rewritten Server manifest whose endpoint is the local forward; the
  WebSocket clients, the Desktop credential handshake, and the Desktop lease are the same code that serves the local
  Server. No extra process stays resident on the remote side and no remote port is exposed beyond loopback.
- **Authentication**: OpenSSH asks for passwords, key passphrases, 2FA codes, and host-key confirmation through
  `SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE=force`. The helper is Desktop's own Electron binary run as Node
  (`ELECTRON_RUN_AS_NODE`), which forwards the prompt over a private, token-authenticated Unix socket to Main; Main
  shows it in the SSH Host's window. Destinations that begin with `-` are rejected so a host string can never become an
  OpenSSH option.
- **Remote layout**: everything lives under `~/.caxri-server/`. `runtimes/<sha256>/node` caches the Node runtime by
  content hash; `builds/<buildId>/` holds one versioned application layer whose runtime is a hard link into the cache;
  `profile/` is that Server's profile. An install uploads only the application layer (a gzip tarball with a
  `SHA256SUMS` covering every file), verifies it, and renames it into place under an install lock, so an upgrade never
  re-transfers the runtime and a partial upload never becomes a build. The remote fetches the runtime from its pinned
  `nodejs.org` URL and verifies its hash; when the remote cannot reach the internet, Desktop streams it instead. Old
  builds are removed only when no running Server uses them.
- **Supported remotes**: Linux x64 and arm64 with glibc 2.28 or newer, the Node 24 baseline. Native modules are built
  in a `manylinux_2_28` container so the artifact honors that floor; musl, macOS, and Windows remotes are not
  supported.
- **Lifecycle**: closing an SSH Host's window or quitting Desktop only detaches, the same as the local window's
  detach. The SSH Host's Server keeps its Terminals and Agents and is reclaimed only by ADR 0010's idle exit, which already
  defers while a PTY is live, or by the explicit **Stop Server on SSH Host** action. A dropped connection reconnects
  automatically with backoff; a reconnect that needs user input (password, 2FA, changed host key) stops retrying until
  the user chooses Reconnect. The existing build-fingerprint staleness check replaces an older Server on the SSH Host the same
  way it replaces a local one.
- **Desktop shape**: each environment (the local Server and each SSH Host) owns one Workbench window and one Server
  connection; Main routes IPC by the sending `WebContents`. A window never shows Projects from two environments. Main
  methods that act on this machine's disk or OS are classified per method as `any`, `local-only`, or `remote-override`
  in one exhaustive table, so a new Main method cannot reach a remote window without a decision. A remote window never
  operates on a local path that happens to match a remote one: Trash, Reveal in Finder, open with the default app,
  external editors, native folder pickers, theme import, and diagnostics export are refused or rerouted through the
  SSH Host's Server.

## Considered options

- **An in-process SSH library (`ssh2`).** Rejected: it would reimplement `~/.ssh/config`, `ProxyJump`, agent
  forwarding, certificates, hardware keys, and `known_hosts` handling that users already configure for OpenSSH, and
  every gap would be a support issue.
- **Run only a thin relay remotely and keep the Server on the Mac.** Rejected: the PTYs, watchers, and Agent hooks
  must live where the Agents run, or a network drop kills the Agent and Files/Git need a second remote protocol.
- **A per-connection `ssh -W` proxy inside Main.** Rejected for the default path: it spawns one `ssh` process per
  WebSocket and duplicates what the ControlMaster forward already does with one channel per connection.
- **Upload a full artifact per version.** Rejected: the Node runtime is most of the artifact and rarely changes, so a
  content-addressed runtime cache cuts every upgrade to the application layer.

## Consequences

- One Desktop attaches to one SSH Host's Server at a time, because the Desktop lease is per Server profile; a second Mac
  connecting to the same SSH Host replaces the first one's lease.
- Remote Agents need their CLIs installed and logged in on the SSH Host; Caxri does not manage remote credentials.
- On hosts where `systemd-logind` uses `KillUserProcesses=yes`, the SSH Host's Server dies with the last SSH session
  unless the user enables lingering; [SSH Host](../ssh-host.md) documents this operator step.

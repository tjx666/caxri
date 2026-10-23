---
kind: adr
status: accepted
---

# macOS on Apple silicon is a supported SSH Host

- Date: 2026-10-23
- Refs: issue #2486
- Amends: [ADR 0014](0014-ssh-remote-server.md) (widens its supported remotes beyond Linux)

ADR 0014 limited SSH Hosts to Linux. Developers also keep a second Mac (a spare laptop or a Mac mini) to run Agents
on, and every competing workbench that offers SSH remotes already accepts macOS. The Server artifact is the same Node
program on both systems, so the cost is in the edges where the remote scripts and layers assumed Linux.

**Decision**: Desktop accepts `Darwin arm64` hosts running macOS 13.5 or newer (the Node 24 minimum) and ships a
`darwin-arm64` remote layer beside the two Linux ones. Layers are keyed by a remote target (`linux-x64`,
`linux-arm64`, `darwin-arm64`), not by CPU architecture, and each descriptor carries its own `systemBaseline`: a glibc
version for Linux, a macOS version for Darwin.

- **Process identity without `/proc`**: the remote scripts read a process's command line from `/proc` on Linux and
  from `ps -ww -o command=` on macOS. Garbage collection reads the running-build set the same way, and when neither
  source can list processes it skips instead of treating the set as empty, because an empty set would remove the build
  a running Server executes from.
- **The layer**: the `darwin-arm64` layer is staged on an Apple silicon build machine with that machine's native addons
  and the official `nodejs.org` Node tarball as its runtime. The build fails when any bundled Mach-O binary declares a
  minimum macOS above the baseline, so the floor the probe enforces is the one the artifact honors.
- **Launch**: macOS has no `setsid`, so the Server starts through the existing bare `nohup` fallback. A `nohup` process
  survives the SSH session and the ControlMaster exiting; launchd adopts it.
- **Trash**: the remote Server moves entries into `~/.Trash`, naming a collision `name 2.ext` the way Finder does,
  without Finder's Put Back record.
- **Unsupported**: Intel Macs, because the build has no `darwin-x64` natives yet; this is a cost deferral, not a product
  decision. macOS privacy prompts (Local Network, Full Disk Access, Keychain) cannot be answered over SSH; Caxri
  documents them instead of working around them.

## Considered options

- **Keep macOS unsupported.** Rejected: the remote Server already runs on macOS locally, and the Linux assumptions were
  confined to process discovery, layer selection, Trash, and status copy.
- **Run the Server as a LaunchAgent.** Deferred: it would give the Server a GUI-session context (Local Network access,
  Keychain), but needs a logged-in GUI session and an install and uninstall story. Plain `nohup` matches the Linux path
  and works for internet-facing Agents.
- **Build the darwin natives in CI from a cross-compiler.** Rejected: the release workflow already runs on macOS arm64,
  so the native addons it installs are the ones the layer needs.

## Consequences

- After the SSH session that started it ends, the Server and its children lose Local Network access on recent macOS:
  connecting to an address on the LAN fails with `EHOSTUNREACH`, while internet access still works.
- Agent CLIs that keep credentials in the login Keychain may report that they are not logged in over SSH.
- `bun run build:remote-layers` builds the `darwin-arm64` layer only on an Apple silicon machine; elsewhere it builds the
  Linux layers and `--target darwin-arm64` fails.

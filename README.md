# Caxri

Caxri is a project-first development workbench for macOS, built for running and supervising coding
agents. It groups durable Agent and Shell Sessions beneath local Projects: Agent Chats, real PTYs, a
focused editor, Files and Source Control views, and reliable agent attention signals, in one
Electron app.

Caxri is in active development. Repository visibility and source-available development releases
do not establish a support or compatibility commitment. The maintainer will declare any future
compatibility commitment explicitly.

## Highlights

- **Projects and Sessions.** A Project is a user-authorized folder. Sessions are durable
  units of work beneath it, each owning its Terminals, layout, and workbench state. The shared
  vocabulary lives in [GLOSSARY.md](GLOSSARY.md).
- **Chat first, Terminal always.** Agents run the user's own, unmodified CLIs (Claude Code,
  Codex, …). A Chat drives the installed CLI through its vendor's structured protocol and renders
  a readable conversation; it is where new Agent features land. Every Agent can also run in a
  genuine pseudo-terminal, and a Chat can switch to one without losing its conversation. Shells
  always run in one, and Caxri never proxies or rewrites PTY I/O. See
  [docs/agent-chat.md](docs/agent-chat.md) and
  [ADR 0015](docs/adr/0015-chat-primary-agent-surface.md).
- **Attention you can trust.** Each Session's Primary Agent reports waiting / completed / failed
  states, so a wall of parallel agent sessions never stalls silently.
- **A focused workbench.** A narrow editor, file tree, search, and an inspection-first Source
  Control view cover the "glance at what the agent did" loop without becoming an IDE.
- **A scriptable CLI.** The standalone `caxri` CLI drives the same authenticated, profile-scoped
  Server that the desktop app uses; see [docs/cli.md](docs/cli.md).
- **An agent-native repository.** Caxri is developed exclusively by coding agents.
  [AGENTS.md](AGENTS.md) is the contributor standing orders; task-routed skills under
  `.agents/skills/` own the workflows.

## Install on macOS

The packaged app currently supports **Apple Silicon Macs**. You do not need to clone this
repository or install Node.js, Bun, or `ni` to use it. Intel Macs can run from source using the
development steps below; Windows and Linux desktop builds are not currently supported.

1. **Prepare your Agent.** Install and sign in to at least one supported Agent CLI, such as
   Claude Code or Codex, following its vendor's instructions. Confirm that it works in Terminal
   before opening it in Caxri. Caxri uses your installed CLIs and their existing authentication;
   it does not include an Agent subscription or credentials. You can also use Shell Sessions
   without an Agent CLI.
2. **Install the notification helper.** Current unsigned builds depend on the
   [`alerter` CLI](https://github.com/vjeantet/alerter) for macOS system notifications, including
   Agent completion and waiting-for-input banners. Install [Homebrew](https://brew.sh/) if needed,
   then run:

   ```bash
   brew install vjeantet/tap/alerter
   ```

   Caxri looks for it at `/opt/homebrew/bin/alerter` or `/usr/local/bin/alerter`. Install it before
   launching Caxri, or fully quit and reopen Caxri afterwards. Without it, system notifications
   may not appear even when enabled in Settings.

3. **Download and verify the app.** Open the
   [latest release](https://github.com/tjx666/caxri/releases/latest) and download
   `Caxri-VERSION-arm64.dmg` and its matching `Caxri-VERSION-arm64.dmg.sha256` file. Keep both
   files in the same folder. In Terminal, change to that folder and verify the download,
   replacing `VERSION` with the version in the downloaded filenames:

   ```bash
   cd ~/Downloads
   shasum -a 256 -c Caxri-VERSION-arm64.dmg.sha256
   ```

   Continue only when the result is `OK`. Use the default `-arm64.dmg` asset; the
   `-arm64-nosourcemap.dmg` asset is a smaller alternative without diagnostic Source Maps.

4. **Install and open Caxri.** Open the DMG, drag **Caxri** into **Applications**, then launch it
   from Applications. The current app is unsigned and unnotarized. If macOS says it is
   **"damaged"**, after verifying the download above, run this command for the installed app
   and open it again:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Caxri.app
   ```

5. **Start your first Session.** Add a local folder as a Project, create a Session beneath it,
   and choose your installed Agent or Shell. To start Agents in the conversation view, enable
   **Settings → General → Open Agents in Chat**. Check **Settings → Notifications → System
   notifications** and allow the notification helper's notifications in macOS System Settings
   if prompted.

To update manually, finish your running tasks, quit Caxri, and repeat the download, verification,
and installation steps with the new release. Installing the app does not require deleting your
profile or Project folders. Contributor installation and release options are documented in
[RELEASING.md](RELEASING.md).

## Run from source

### Development requirements

- macOS (Apple Silicon or Intel for development from source)
- Node.js 24 or newer
- Bun 1.3 or newer
- Xcode Command Line Tools
- [`ni`](https://github.com/antfu-collective/ni)

### Development quick start

Clone this repository and open its directory, then run:

```bash
ni
bun run dev
```

`bun run dev` is the first-clone path in this checkout. Coding-agent sessions and parallel
worktrees start through `$switch-worktree` so each checkout gets its own profile; see
[AGENTS.md](AGENTS.md).

Desktop, Server Core, Terminal Host, and Extension Host logs are written beneath the active
profile's `<userData>/logs/` directory. Unsigned development packages are written beneath
`release.noindex/`. Install or upgrade the default Source Map release with
`bun run install:caxri`: terminal downloads skip the Gatekeeper quarantine that makes
browser-downloaded unsigned apps report as "damaged" (see [RELEASING.md](RELEASING.md)).

Caxri's Server Core-owned native ESM extension model and ViewContainer contribution contract are
described in [docs/extensions.md](docs/extensions.md).

Caxri's own diagnostics and reporting paths do not collect or upload source contents, Terminal
output, or Agent transcripts. Caxri runs separately installed third-party Agent CLIs; their network
behavior and data handling are governed by their respective vendors' terms and privacy policies.

## Command line

```bash
bun run build:cli
node apps/cli/dist/caxri.cjs --help
```

The `caxri` CLI is a standalone Node.js 24+ bundle that talks only to the authenticated Server:
never directly to Caxri's database, settings, or logs. It covers Projects, Sessions, Terminals,
settings, logs, diagnostics, events, desktop window control, and Agent automation, and embeds the
version-matched `caxri-cli` Agent skill. The full manual, including output modes, mutation safety,
and command authority boundaries, is in [docs/cli.md](docs/cli.md).

## Community and support

- [Open an Issue](https://github.com/tjx666/caxri/issues/new/choose) for a bug or feature request.
  Issues are open for community use, but there is no response or resolution SLA.
- Pull requests are welcome for review. The maintainer decides whether to merge each contribution,
  and submission does not guarantee review or acceptance. See
  [CONTRIBUTING.md](CONTRIBUTING.md).
- Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Never post credentials,
  sensitive exploit details, or private data in a public Issue.
- See [SUPPORT.md](SUPPORT.md) for the boundary between bug reports, feature requests, security
  reports, and general support.

## License

Caxri is source-available under the [Caxri Source-Available License 1.0](LICENSE). It is not licensed
under an OSI-approved open source license.

Using Caxri for personal or company work, earning money from Outputs created with it, and keeping
private Modifications closed source are free. Free redistribution is allowed under the License's
notice and source-availability conditions. Selling, commercially distributing, or monetizing access
to Caxri or a Modification requires a separate written commercial license. Contact
[ytj2713151713@gmail.com](mailto:ytj2713151713@gmail.com) for commercial terms.

External Contributions require acceptance of the [Caxri Individual Contributor License
Agreement](CLA.md) before merge. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow.

## Development

Validation gates, from focused to exhaustive:

```bash
bun run --silent check [files...]   # changed-file lint / type / test routing
bun run lint && bun run lint:type-aware
bun run typecheck
bun run test
bun run test:e2e                    # Playwright Electron workflows
bun run build && bun run package
```

Git hooks live in the repository-owned `.githooks` directory (`core.hooksPath` is configured on
install); pre-commit runs `lint-staged`. Startup performance is gated by
`CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/large/repository bun run benchmark:startup`, which requires
Server Core, Terminal, file tree, and Git to become usable within three seconds. Native
compatibility probes: `bun run spike:native`, `spike:pty`, `spike:agents`.

[AGENTS.md](AGENTS.md) is the always-on standing orders. Isolated worktrees, CI watching, and
architecture contracts live in the owning `.agents/skills/` entries. Bundle budgets live in
[docs/bundle-size.md](docs/bundle-size.md).

## Documentation

| Document                                                                               | Contents                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [GLOSSARY.md](GLOSSARY.md)                                                             | Product language: Projects, Sessions, Attention            |
| [DESIGN.md](DESIGN.md)                                                                 | Authoritative UI and interaction spec                      |
| [AGENTS.md](AGENTS.md)                                                                 | Contributor standing orders for coding agents              |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                                     | Issue and pull request contribution workflow               |
| [LICENSE](LICENSE)                                                                     | Source-available use and commercial licensing terms        |
| [CLA.md](CLA.md)                                                                       | Contributor license agreement                              |
| [SECURITY.md](SECURITY.md)                                                             | Private vulnerability reporting policy                     |
| [SUPPORT.md](SUPPORT.md)                                                               | Community support scope and request routing                |
| [docs/README.md](docs/README.md)                                                       | Full index of every living doc, ADR, and historical record |
| [docs/cli.md](docs/cli.md)                                                             | The `caxri` CLI manual                                     |
| [RELEASING.md](RELEASING.md)                                                           | Release workflow for the unsigned DMG                      |
| [Project architecture](.agents/skills/project-architecture/references/architecture.md) | Process model, recovery contracts, dependency baseline     |

## Product boundaries

Caxri treats a user-selected folder as a Project and groups durable Sessions beneath it. It is
not an agent wrapper, a VS Code fork, or an orchestration platform. Agent CLIs run unmodified,
through their vendor's structured protocol (a Chat, the primary surface) or in a real PTY (always
supported). Source Control is an inspection surface: the only Git mutation is switching to an
existing local branch. The editor intentionally stays narrow.

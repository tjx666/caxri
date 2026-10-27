# Caxri

Caxri is an Agent Development Environment (ADE) for macOS: the place where you build software
through the coding Agents you already use, Claude Code, Codex and Grok Build. It gives those Agents
one consistent workflow, keeps each task as a durable Session under a local Project folder, handles
your subscription's limits with automation, and shows only what still needs you: which Session is
waiting, and what its Agent changed. Agents change quickly, so Caxri ships often and adapts with
them.

**Works with:** Claude Code, Codex and Grok Build. Caxri runs your own installed Agent CLIs and
their existing sign-in; it does not bundle an Agent or a subscription. The interface is available
in English and Simplified Chinese.

Caxri is in active development. Repository visibility and source-available development releases
do not establish a support or compatibility commitment. The maintainer will declare any future
compatibility commitment explicitly.

## Highlights

- **Projects and Sessions.** A Project is a folder you authorize. Sessions are durable units of
  work beneath it, each with its own Terminals, layout and workbench state. The shared vocabulary
  lives in [GLOSSARY.md](GLOSSARY.md).
- **One workflow across Agents.** Sessions, Chat, attention and usage work the same way whichever
  Agent runs the task. Claude Code and Codex are supported first; when an Agent lacks a capability,
  that Agent simply goes without it.
- **Chat first, Terminal always.** An Agent opens as a readable conversation (a Chat) by default,
  and can switch to a genuine terminal without losing the conversation. Shells always run in a
  terminal. See [docs/agent-chat.md](docs/agent-chat.md).
- **Your subscription, working for you.** Eligible idle Claude Code and Grok Build Chats are
  compacted before their prompt cache expires, a Chat stopped by a used-up limit resumes on its own
  when the reset is known and near, and when a plan runs out you can continue the work with another
  Agent. See [docs/session-compaction.md](docs/session-compaction.md) and
  [docs/agent-usage-continuation.md](docs/agent-usage-continuation.md).
- **Attention you can trust.** Each Session reports waiting, completed or failed, so a wall of
  parallel Agents never stalls silently.
- **Only what you still need to see.** A narrow editor, file tree, search and a review-first Source
  Control view cover the "glance at what the Agent did" loop without becoming an IDE.
- **Built for Agents to drive.** The `caxri` command and its bundled skill let Agents drive the
  same app Server: create Sessions, delegate work and report back. Agents commit; you merge the
  pull request. See [docs/cli.md](docs/cli.md).

New here? Read [Getting started](docs/getting-started.md) for the model in five minutes.

## Requirements

- An Apple Silicon Mac running macOS 13 (Ventura) or later.
- At least one supported Agent CLI (Claude Code, Codex or Grok Build) installed and signed in. Check
  that it works in Terminal first. Shell Sessions work without one.
- [Homebrew](https://brew.sh/), only to install the optional notification helper.

Intel Macs can run from source (see [Run from source](#run-from-source)); Windows and Linux desktop
builds are not currently supported.

## Install

Paste this into your coding agent (Claude Code, Codex, Grok Build, or similar):

```text
Install Caxri for me by following https://raw.githubusercontent.com/tjx666/caxri/main/docs/install.md
```

The agent checks your Mac, downloads and verifies the latest release, installs it, and offers
optional setup: notification banners, the `caxri` command, and initial settings such as language,
default Agent, and font sizes. To install by hand, follow the same page:
[docs/install.md](docs/install.md). If macOS blocks the app, see
[Troubleshooting](docs/troubleshooting.md).

### Install on Android

Android phones can install the paired companion from the same
[Release](https://github.com/tjx666/caxri/releases/latest): download
`Caxri-Mobile-<version>-android-arm64.apk`, open it, and allow installation from the browser or
file manager if prompted. Each APK has a `.sha256` companion; use the same release version as Desktop.
See [Mobile installation and updates](docs/mobile/update.md#install-from-github-releases).

## First Session

Add a local folder as a Project, create a Session beneath it, and choose your installed Agent or a
Shell. Agents open in Chat by default; you can switch a Session to its terminal at any time.

Agents start with full access: they can edit files and run commands without asking. Change this in
**Settings → Agents**. Allow notifications from the helper in macOS System Settings if prompted.

## Updating

Caxri checks GitHub for a new release when it launches and every few hours afterwards. You can also
choose **Caxri → Check for Updates…** at any time. A new version downloads in the background; when it
is ready, choose **Restart to Update**, or simply quit Caxri and the next launch is the new version.
If Caxri cannot replace itself (for example, it runs from the disk image), the dialog explains how to
install the downloaded disk image by hand. Updating does not delete your profile or Project folders.
See [Desktop updates](docs/desktop-updates.md). Contributor release
options are in [RELEASING.md](RELEASING.md).

## Command line for app users

Open the Command Palette and run **Install 'caxri' Command in PATH**, then in a new Terminal:

```bash
caxri --help
```

The full manual is [docs/cli.md](docs/cli.md).

## What Caxri changes on your Mac

- **Agent hook entries.** To learn when an Agent starts, waits or finishes, Caxri adds lifecycle
  hook entries to your Agent configs (for example `~/.claude/settings.json` and the Codex hook
  config). Hooks receive lifecycle phases, never prompt or response content. Turn them off per
  Agent in **Settings → Agents**, which removes Caxri's entries; your own hooks stay.
- **A background job for Claude windows (Claude Pro).** **Keep 5-hour windows rolling** (Settings → Agents → Claude)
  is on by default for a Claude Pro account and off for Max. When on, Caxri registers a per-user
  launchd job under `~/Library/LaunchAgents` (names start with `com.caxri.app.claude-windows`;
  macOS lists it under Login Items) that sends one minimal request to Claude when a window resets.
  Turn the setting off to remove it. See [docs/claude-windows.md](docs/claude-windows.md).
- **The `caxri` command link (only if you installed it).** **Install 'caxri' Command in PATH** in the
  command palette creates the symlink `/usr/local/bin/caxri`. Run **Uninstall 'caxri' Command from
  PATH** before deleting the app, or remove it later with `sudo rm /usr/local/bin/caxri`.
- **The notification helper.** `alerter` is installed by you with Homebrew; Caxri only runs it.
- **Your data.** The profile (database, settings) lives in `~/Library/Application Support/Caxri`,
  with logs under its `logs` folder. Use **Help → Reveal Logs in Finder** to open them.
- **Two kinds of network requests.** Caxri asks GitHub's public release API for new versions, and,
  while the Claude windows setting is on, sends the one minimal request to Claude described above.
  It has no telemetry, and its diagnostics never include source contents, Terminal output or Agent
  transcripts. Your Agent CLIs talk to their own vendors under their own terms.

## Uninstall and reset

Quit Caxri, delete `/Applications/Caxri.app`, then remove `~/Library/Application Support/Caxri`
to erase its data. Deleting a Project or Session in Caxri never touches your folders or files.
Before deleting, turn off Agent hooks and **Keep 5-hour windows rolling** (on by default for Claude Pro) in Settings so Caxri removes its
config entries and background job. If you installed the `caxri` command, run **Uninstall 'caxri'
Command from PATH** from the command palette too (or `sudo rm /usr/local/bin/caxri` afterwards). From a source checkout, `bun run uninstall:caxri` previews a full
local cleanup (hook entries, background jobs, app and profiles) and archives rather than deletes;
add `-- --yes` to apply it.

## Support and community

- [Open an Issue](https://github.com/tjx666/caxri/issues/new/choose) for a bug, feature request or
  question. There is no response or resolution SLA. Use **Help → Report an Issue** in the app.
- Pull requests from people and coding agents are welcome; the maintainer decides what to merge.
  See [CONTRIBUTING.md](CONTRIBUTING.md).
- Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
- See [SUPPORT.md](SUPPORT.md) for request routing and [docs/troubleshooting.md](docs/troubleshooting.md)
  for common problems.

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

<!-- development-usage:start -->

## Development usage

Personal Caxri development usage from retained local logs, as of **2026-10-16 16:06:46.819 UTC**.
Includes Codex, Claude Code, Grok Build, child agents, identifiable Caxri worktrees and auxiliary directories, and deduplicated Claude session backups.

| Tool        | Tokens (input + output) | Known USD cost |
| ----------- | ----------------------: | -------------: |
| Codex       |          32,126,801,733 |     $15,432.31 |
| Claude Code |          22,747,324,361 |     $11,841.26 |
| Grok Build  |             558,492,406 |        $139.65 |
| **Total**   |      **55,432,618,500** | **$27,413.22** |

Codex and Claude costs are **standard API list-price equivalents**, using the price snapshot checked on 2026-10-16. Grok uses its recorded USD cost. These are not subscription payments or historical invoices.
Token totals include cache reads and writes once; reasoning is already included in output. Long-context rates apply per request; unspecified Claude cache-write TTLs use the 5-minute rate.
Unpriced usage: **513,884 tokens**. Grok sessions without usable usage: **20**. Deleted logs, other machines, hosted agents and unattributable work are outside this snapshot.

Update with `bun run usage:development --write`; omit `--write` to preview, use `--json` for aggregate JSON, or `--as-of <ISO timestamp>` for a fixed cutoff. The active Codex accounting session and its identifiable descendants are excluded when `CODEX_THREAD_ID` is available.
The script reads session files without changing them. Default backup paths use `~`; additional Claude project directories can be supplied with `--claude-backup <path>`. Prices are pinned in [the price snapshot](scripts/development-usage-prices.json); review that snapshot when model prices change.

Pricing sources: [OpenAI](https://developers.openai.com/api/docs/pricing), [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing).

<!-- development-usage:end -->

## Run from source

### Development requirements

- macOS 13 or newer (Apple Silicon or Intel for development from source)
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

### Build the CLI from source

```bash
bun run build:cli
node apps/cli/dist/caxri.cjs --help
```

The `caxri` CLI is a standalone Node.js 24+ bundle that talks only to the authenticated Server:
never directly to Caxri's database, settings, or logs. It covers Projects, Sessions, Terminals,
settings, logs, diagnostics, events, desktop window control, and Agent automation, and embeds the
version-matched `caxri-cli` Agent skill. The full manual, including output modes, mutation safety,
and command authority boundaries, is in [docs/cli.md](docs/cli.md).

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

### Use Caxri

| Document                                   | Contents                                        |
| ------------------------------------------ | ----------------------------------------------- |
| [Getting started](docs/getting-started.md) | The model in five minutes                       |
| [Troubleshooting](docs/troubleshooting.md) | Blocked app, notifications, Agent not found     |
| [docs/cli.md](docs/cli.md)                 | The `caxri` CLI manual                          |
| [GLOSSARY.md](GLOSSARY.md)                 | Product language: Projects, Sessions, Attention |
| [SUPPORT.md](SUPPORT.md)                   | Community support scope and request routing     |
| [SECURITY.md](SECURITY.md)                 | Private vulnerability reporting policy          |
| [LICENSE](LICENSE)                         | Source-available use and commercial licensing   |

### Contribute

| Document                                                                               | Contents                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                                     | Issue and pull request contribution workflow               |
| [CLA.md](CLA.md)                                                                       | Contributor license agreement                              |
| [AGENTS.md](AGENTS.md)                                                                 | Contributor standing orders for coding agents              |
| [DESIGN.md](DESIGN.md)                                                                 | Authoritative UI and interaction spec                      |
| [docs/README.md](docs/README.md)                                                       | Full index of every living doc, ADR, and historical record |
| [RELEASING.md](RELEASING.md)                                                           | Release workflow for the unsigned DMG                      |
| [Project architecture](.agents/skills/project-architecture/references/architecture.md) | Process model, recovery contracts, dependency baseline     |

## Product boundaries

Caxri treats a user-selected folder as a Project and groups durable Sessions beneath it. It runs
your installed Agent CLIs unmodified, through their vendor's structured protocol (a Chat, the core
surface) or in a real PTY (always supported), and leaves sign-in to the CLIs. Source Control is for
reviewing Agent work: there is no manual stage or commit, because Agents commit. A person still
decides the merge, so Caxri offers a pull request merge button. The editor intentionally stays
narrow, and Caxri is not an IDE or a VS Code fork. The principles behind these boundaries are
recorded in [ADR 0020](docs/adr/0020-agent-development-environment.md).

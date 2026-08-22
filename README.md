# Caxri

Caxri is a project-first, terminal-native development workbench for macOS, built for running and
supervising coding agents. It groups durable Agent and Shell Sessions beneath local Projects —
real PTYs, a focused editor, file and Git inspectors, and reliable agent attention signals in one
Electron app.

## Highlights

- **Projects and Sessions.** A Project is a user-authorized local directory; Sessions are durable
  units of work beneath it, each owning its Terminals, layout, and workbench state. The shared
  vocabulary lives in [CONTEXT.md](CONTEXT.md).
- **Real PTYs, no wrappers.** Shell and Agent CLIs (Claude Code, Codex, …) run in genuine
  pseudo-terminals. Caxri observes them; it never proxies or rewrites their I/O.
- **Attention you can trust.** Each Session's Primary Agent reports waiting / completed / failed
  states, so a wall of parallel agent sessions never stalls silently.
- **A focused workbench.** A narrow editor, file tree, search, and read-only Git inspector cover
  the "glance at what the agent did" loop without becoming an IDE.
- **A scriptable CLI.** The standalone `caxri` CLI drives the same authenticated, profile-scoped
  Host that the desktop app uses — see [docs/cli.md](docs/cli.md).
- **An agent-native repository.** Caxri is developed exclusively by coding agents;
  [AGENTS.md](AGENTS.md) is the contributor guide and the source of truth for workflows and
  guardrails.

## Requirements

- macOS on Apple Silicon or Intel
- Node.js 24 or newer
- Bun 1.3 or newer
- Xcode Command Line Tools
- [`ni`](https://github.com/antfu-collective/ni)

## Quick start

```bash
ni
bun run dev
```

Main, Host, and Runtime logs are written beneath the active runtime profile's `<userData>/logs/`
directory. Unsigned development packages are written beneath `release/`; tagged releases publish
an unsigned Apple Silicon DMG. Install or upgrade the released app with
`bun run install:caxri` — terminal downloads skip the Gatekeeper quarantine that makes
browser-downloaded unsigned apps report as "damaged" (see [RELEASING.md](RELEASING.md)).

Caxri does not upload telemetry, terminal output, file content, or agent transcripts.

## Command line

```bash
bun run build:cli
node packages/cli/dist/caxri.cjs --help
```

The `caxri` CLI is a standalone Node.js 24+ bundle that talks only to the authenticated Headless
Host — never directly to Caxri's database, settings, or logs. It covers Projects, Sessions,
Terminals, settings, logs, diagnostics, events, desktop window control, and Agent automation, and
embeds the version-matched `caxri-cli` Agent skill. The full manual, including output modes,
mutation safety, and command authority boundaries, is in [docs/cli.md](docs/cli.md).

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
Runtime, Terminal, file tree, and Git to become usable within three seconds. Native compatibility
probes: `bun run spike:native`, `spike:pty`, `spike:agents`.

[AGENTS.md](AGENTS.md) documents the complete contributor workflow: isolated worktrees, CI
watching, bundle budgets, and the repository's architecture guardrails.

## Documentation

| Document                                                                               | Contents                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [CONTEXT.md](CONTEXT.md)                                                               | Product language: Projects, Sessions, Attention        |
| [DESIGN.md](DESIGN.md)                                                                 | Authoritative UI and interaction spec                  |
| [AGENTS.md](AGENTS.md)                                                                 | Contributor guide for coding agents                    |
| [docs/cli.md](docs/cli.md)                                                             | The `caxri` CLI manual                                 |
| [docs/agent-command-authority.md](docs/agent-command-authority.md)                     | Agent capability and audit boundaries                  |
| [docs/agent-actions.md](docs/agent-actions.md)                                         | Unified Agent skills and slash-command picker          |
| [docs/bundle-size.md](docs/bundle-size.md)                                             | Bundle baseline and the CI budget gate                 |
| [RELEASING.md](RELEASING.md)                                                           | Release workflow for the unsigned DMG                  |
| [Project architecture](.agents/skills/project-architecture/references/architecture.md) | Process model, recovery contracts, dependency baseline |

## Product boundaries

Caxri treats a user-selected directory as a Project and groups durable Sessions beneath it. It is
not an agent wrapper, a VS Code fork, or an orchestration platform. Agent CLIs always run in a
real PTY. Git integration is read-only and the editor intentionally stays narrow.

# Caxri

Caxri is a project-first, terminal-native local development workbench for macOS. It groups durable Agent and Shell Sessions beneath local Projects, with real PTYs, a focused editor, file and Git inspectors, current-Session Terminal information, and read-only Claude Code/Codex metadata in one Electron app.

## Requirements

- macOS on Apple Silicon or Intel
- Node.js 22.12 or newer
- Bun 1.3 or newer
- Xcode Command Line Tools
- `ni`

## Development

```bash
ni
bun run dev
```

Development logs are written to `logs/host.jsonl`, `logs/main.jsonl`, and `logs/runtime.jsonl` in the repository root.

## Command line

The scriptable `caxri` CLI talks only to the authenticated, profile-scoped Headless Host. It never
reads Caxri's SQLite database, settings, or logs directly. Local help and protocol introspection work
without a running Host:

```bash
bun run build:cli
node packages/cli/dist/caxri.cjs --help
node packages/cli/dist/caxri.cjs capabilities --json
```

`packages/cli/dist/caxri.cjs` is the standalone artifact and requires Node.js 22.12 or newer. The
macOS app contains the exact same bundle at `Caxri.app/Contents/Resources/cli/caxri.cjs` plus an
app-managed launcher at `Caxri.app/Contents/Resources/bin/caxri`; that launcher uses the packaged
Electron executable only in `ELECTRON_RUN_AS_NODE=1` mode. It also supplies the immutable packaged
Host entry, so a headless-capable command automatically starts the profile Host when none exists.
The standalone bundle keeps offline introspection available and connects to an existing Host without
acquiring Electron or native-module dependencies of its own.

Human TTY output is concise text. `--json` reserves stdout for one stable JSON value, while
`--quiet` emits one opaque ID per line. Supported Agent and CI environments default to JSON and do
not prompt. Select another isolated profile with `--profile <absolute-path>`; every mutation requires
that explicit Host selector and non-interactive confirmation with `--yes`.

The shared business surface includes `project list|show|current`, `session list|show|current`,
`terminal list|show`, `settings get|validate|patch`, `logs query|follow`,
`diagnostics snapshot`, and `events watch`. Settings writes accept repeated `--set key=value`
arguments; `settings validate` and `settings patch --dry-run` use the real Runtime schema without
writing. Pass `--request-id <id>` when a mutation must be safely retried. Streaming commands stop on
Ctrl+C, keep data on stdout, and send keepalives or cursor-gap warnings only to stderr.

Desktop window commands stay behind the authenticated Host and Project-root authorization:
`desktop focus`, `open <path>`, and `reveal <path>`. Path commands accept an optional exact
`--session <id>`; `open` supports files and directories and launches Desktop by default, while
`--no-launch` returns `UNAVAILABLE` when no Desktop lease exists. As with every human mutation,
non-interactive calls require `--profile`, `--yes`, and should use a stable `--request-id` when
retried.

Agent automation deliberately separates Peer Messages (`agent message`), durable Agent lifecycle
operations (`agent dispatch` and `agent control`), and owner-only simulated input (`terminal send`).
They do not alias or fall back to one another. See
[Agent command authority](docs/agent-command-authority.md) for the capability and audit boundaries.

Every CLI artifact embeds the version-matched canonical `caxri-cli` Agent skill. `skills list`,
`skills get`, and `skills status` work without a Host. Installation requires an explicit
`--provider claude|codex` and `--local|--global` scope; Project-local is recommended, global scope is
never implied, and Caxri refuses to overwrite unmarked, modified, unknown-schema, or newer entries.
The canonical source is [`skills/caxri-cli/SKILL.md`](skills/caxri-cli/SKILL.md), and the CLI build
validates every executable example and declared capability against the live registries before
embedding it.

Default Terminal shortcuts are configurable in Settings → Keybindings:

| Shortcut    | Action                              |
| ----------- | ----------------------------------- |
| `Command+K` | Clear the active Terminal view      |
| `Command+T` | Create and focus a new Terminal tab |
| `Command+W` | Close the active Terminal tab       |

Git hooks use the repository-owned `.githooks` directory through Git's native `core.hooksPath`. Dependency installation configures it automatically, and the pre-commit hook runs `lint-staged`.

Authoritative validation commands:

```bash
bun run --silent check
bun run lint
bun run format:md:check
bun run typecheck
bun run test
bun run test:e2e
bun run build
bun run package
```

Large-Project startup performance gate:

```bash
CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/large/repository bun run benchmark:startup
```

The gate requires Runtime, Terminal, file tree, and Git to become usable within three seconds, checks their structured timings and aggregated PTY input metrics, keeps the Runtime below 256 open descriptors, and fails on IPC or watcher errors.

Native compatibility probes:

```bash
bun run spike:native
bun run spike:pty
bun run spike:agents
```

Unsigned development packages are written beneath `release/`. Caxri does not upload telemetry, terminal output, file content, or agent transcripts.

## Product boundaries

Caxri treats a user-selected directory as a Project and groups durable Sessions beneath it. It is not an agent wrapper, a VS Code fork, or an orchestration platform. Agent CLIs always run in a real PTY. Git integration is read-only and the editor intentionally stays narrow.

See [DESIGN.md](DESIGN.md) for frontend and UI design. Project architecture and recovery contracts live in the [project architecture reference](.agents/skills/project-architecture/references/architecture.md), with the [dependency baseline](.agents/skills/project-architecture/references/stack-baseline.md) alongside it.

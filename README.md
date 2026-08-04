# Caxri

Caxri is a project-first, terminal-native local development workbench for macOS. It groups durable Agent and Shell Sessions beneath local Projects, with real PTYs, a focused editor, file and Git inspectors, and read-only Claude Code/Codex metadata in one Electron app.

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

Development logs are written to `logs/main.jsonl` and `logs/runtime.jsonl` in the repository root.

Git hooks use the repository-owned `.githooks` directory through Git's native `core.hooksPath`. Dependency installation configures it automatically, and the pre-commit hook runs `lint-staged`.

Authoritative validation commands:

```bash
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

See [DESIGN.md](DESIGN.md) for architecture and recovery contracts and [docs/stack-baseline.md](docs/stack-baseline.md) for the dependency baseline.

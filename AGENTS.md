# Caxri contributor guide

## Commands

- Install dependencies: `ni`
- Start the Electron app: `bun run dev`
- Format Markdown: `bun run format:md`; verify formatting: `bun run format:md:check`
- Validate: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:e2e`
- Large-Project performance gate: `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:startup`
- Build/package: `bun run build`, `bun run package`
- Native probes: `bun run spike:native`, `bun run spike:pty`, `bun run spike:agents`

## Architecture boundaries

- Renderer code never imports Node.js, Electron, PTY, Git, or filesystem APIs.
- The preload exposes only the typed `window.caxri` allowlist from `src/shared/contracts.ts`.
- Main owns windows, native dialogs, application lifecycle, and Runtime supervision.
- The utility-process Runtime owns SQLite, PTYs, Git, files/watchers, settings, themes, adapters, and diagnostics.
- Add operations to the structured request contract. Never accept an arbitrary shell command from the Renderer.
- All paths must be validated against the authoritative Project root before filesystem or Git access.
- Directory-picker authorization is a short-lived, single-use Main-process grant and must be revoked when Project creation is canceled.
- A Project owns one local root; Sessions reference the Project by ID and cannot submit a root path.
- Session identity still isolates editor and layout state. Key or reset Session-scoped Renderer state when the selected Session changes.
- Project and Session deletion remove metadata only. They must never remove the Project directory or user files.
- Diagnostics must exclude source contents, terminal output/snapshots, agent transcripts, credentials, and secret-like setting values.

## Code conventions

- UI strings, code, comments, docs, and commit messages use English.
- Prefer JSDoc for non-obvious lifecycle/security behavior and document why a workaround exists.
- Keep the editor intentionally narrow: open/edit/save/in-file search/diff only.
- Preserve the explicit external-change rule: disk changes replace dirty editor buffers without prompting.
- Read Agent state only through capability-detected metadata indexes; never parse transcripts for UI metadata or write third-party Agent state.
- Use structured argv arrays for Git and PTY launches; never concatenate an untrusted command string.
- Keep unit and integration tests with their source domain, using `__tests__/` when the source directory is already busy. Reserve `e2e/` for full Electron workflows.
- Keep every JavaScript and TypeScript code file at or below 800 physical lines; split cohesive modules before they exceed the ESLint `max-lines` gate.
- Update `DESIGN.md`, tests, and these commands when an architecture contract changes.

## Performance and observability

- Keep Runtime, Terminal, file tree, and Git startup below the three-second large-Project gate.
- Coalesce concurrent expensive reads and probes; React StrictMode must not duplicate native work.
- Send live PTY output only to attached Renderer views, and restore snapshots before replaying output buffered during attachment.
- Log timings at operation boundaries. Aggregate high-frequency PTY metrics instead of writing one log record per input, resize, or output event.
- Performance changes must include a focused regression test or a benchmark assertion.
- Development logs are written to `logs/main.jsonl` and `logs/runtime.jsonl`; packaged builds use the Electron user-data directory.

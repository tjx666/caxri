# Caxri contributor guide

## Commands

- Install dependencies: `ni`
- Start the Electron app: `bun run dev`
- Format: `bun run format`; verify formatting: `bun run format:check`
- Format Markdown: `bun run format:md`; verify formatting: `bun run format:md:check`
- Focused changed-file validation: `bun run check [files...] [--lint] [--test] [--type] [--staged]`
- Validate: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:e2e`
- Cheap post-change smoke gate (~30s Electron launch): `bun run test:smoke`
- Large-Project performance gate: `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:startup`
- Build/package: `bun run build`, `bun run package`
- Native probes: `bun run spike:native`, `bun run spike:pty`, `bun run spike:agents`

## Skills

Detailed playbooks live under `.agents/skills/` (`build`, `debug`, `performance`, `project-architecture`, `quality-check`, `release`, `test`). `.claude/skills` is a compatibility symlink to the same canonical directory. Use the skills for step-by-step workflows beyond this summary.

## Architecture boundaries

- Renderer code never imports Node.js, Electron, PTY, Git, or filesystem APIs.
- The preload exposes only the typed `window.caxri` allowlist from `src/shared/ipc`, whose method table, domain schemas, event union, and error taxonomy are the single source of truth for both processes.
- Main owns windows, native dialogs, application lifecycle, and Runtime supervision.
- The utility-process Runtime owns SQLite, PTYs, Git, files/watchers, settings, themes, adapters, and diagnostics.
- Add operations to the structured request contract. Never accept an arbitrary shell command from the Renderer.
- Validate filesystem paths against the selected Session's Project root. Git may access another linked repository only when its root is already covered by an explicitly added Project.
- Directory-picker authorization is a short-lived, single-use Main-process grant and must be revoked when Project creation is canceled.
- A Project owns one local root; Sessions reference the Project by ID and cannot submit a root path.
- Session identity still isolates editor and layout state. Key or reset Session-scoped Renderer state when the selected Session changes.
- Project and Session deletion remove metadata only. They must never remove the Project directory or user files.
- Diagnostics must exclude source contents, terminal output/snapshots, agent transcripts, credentials, and secret-like setting values.

## Code conventions

- UI strings, code, comments, docs, and commit messages use English.
- Prefer JSDoc for non-obvious lifecycle/security behavior and document why a workaround exists.
- Keep the editor intentionally narrow: open/edit/save/in-file search/diff only.
- Style the Renderer with Tailwind v4 utilities backed by the semantic runtime theme tokens. Color utilities must reference tokens only (`bg-surface`, `text-muted`); the default palette is unregistered, and literal color utilities are forbidden. See the styling principle in `DESIGN.md`.
- Preserve the explicit external-change rule: disk changes replace dirty editor buffers without prompting.
- Read Agent state only through capability-detected metadata indexes; never parse transcripts for UI metadata or write third-party Agent state.
- Let the first Agent Terminal own the Session title, and keep the Info inspector scoped to Terminals actually started in that Session.
- Use structured argv arrays for Git and PTY launches; never concatenate an untrusted command string.
- Keep unit and integration tests with their source domain, using `__tests__/` when the source directory is already busy. Reserve `e2e/` for full Electron workflows.
- Keep every JavaScript and TypeScript code file at or below 800 physical lines; split cohesive modules before they exceed the ESLint `max-lines` gate.
- Keep root `DESIGN.md` focused on frontend and UI design. Update the `project-architecture` skill references, tests, and these commands when an architecture or toolchain contract changes.

## Testing workflow

- During implementation, run only tests affected by the changed source files. Do not run `bun run test` or `bun run test:e2e` as a routine iteration step.
- Prefer `bun run check <changed files>` for the default post-edit pass; use `--lint --test --type` when a shared TypeScript contract changes.
- Run focused Vitest files with `bunx vitest run --silent='passed-only' <test-file...>`.
- Run focused Electron coverage with `bunx playwright test <e2e-file> --reporter=line`; use `-g '<test name>'` when only one workflow changed.
- Finish source edits before updating tests. For a bug fix, first add or identify a behavior-level regression that fails for the bug and passes after the fix.
- Prefer observable output and integration boundaries over internal call assertions. Mock Electron IPC or native boundaries for unit tests; reserve a real Electron launch for the smallest relevant E2E workflow.
- Run the full unit or E2E suite only for release/CI parity, when explicitly requested, or when a shared cross-cutting contract makes the focused scope insufficient.

### Scripted repro

Launch Caxri headlessly, without the interactive directory picker, using environment variables read in `src/main/index.ts` and `src/main/test-root.ts`:

- `CAXRI_E2E=1` selects test mode.
- `CAXRI_USER_DATA_DIR=<tmpdir>` isolates Electron's user-data directory from a developer's real profile.
- `CAXRI_TEST_ROOT_PATH=<dir>` stubs the directory-picker grant with a fixed Project root (see `src/main/test-root.ts`); only honored when `CAXRI_E2E=1` and the app is unpackaged.

Structured logs land in `logs/main.jsonl` and `logs/runtime.jsonl` in development; packaged/test launches write under the active Electron user-data directory instead.

## Performance and observability

- Keep Runtime, Terminal, file tree, and single- or multi-repository Git startup below the three-second large-Project gate.
- Coalesce concurrent expensive reads and probes; React StrictMode must not duplicate native work.
- Send live PTY output only to attached Renderer views, and restore snapshots before replaying output buffered during attachment.
- Log timings at operation boundaries. Aggregate high-frequency PTY metrics instead of writing one log record per input, resize, or output event.
- Performance changes must include a focused regression test or a benchmark assertion.
- Development logs are written to `logs/main.jsonl` and `logs/runtime.jsonl`; packaged builds use the Electron user-data directory.

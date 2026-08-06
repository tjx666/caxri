# Caxri contributor guide

## Commands

- Install dependencies: `ni`
- Start the Electron app: `bun run dev`
- Format: `bun run format`; verify formatting: `bun run format:check`
- Format Markdown: `bun run format:md`; verify formatting: `bun run format:md:check`
- Focused changed-file validation: `bun run check [files...] [--lint] [--test] [--type] [--knip] [--staged]`
- Validate: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:e2e`
- CI-blocking gates with no local wrapper elsewhere: `bun run knip` (dead code/exports) and `bun run doctor` (React health). Run `knip` (or `check --knip`) before pushing renderer or shared-contract changes; `doctor` is slower and usually left to CI.
- `package.json` pins `packageManager` to npm for electron-builder's `install-app-deps` native rebuilds; day-to-day commands still use `ni` and `bun run`.
- Cheap post-change smoke gate (~30s Electron launch): `bun run test:smoke`
- Large-Project performance gate: `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:startup`
- Build/package: `bun run build`, `bun run package`, `bun run package:dmg`
- GitHub Release: follow `RELEASING.md`; only a pushed `main` commit whose subject exactly matches
  `release: v<package-version>` triggers the remote macOS release workflow.
- Native probes: `bun run spike:native`, `bun run spike:pty`, `bun run spike:agents`
- Issue tracking lives in GitHub issues (`gh issue`); this project does not use Linear.

## Forbidden

- Install dependencies only with `ni`; `package-lock.json` is the only lockfile, so never run `bun install`, `pnpm install`, or `yarn`, and never commit a second lockfile.
- Never change the `typescript` / `@typescript/native` dependency aliases or run `npm i typescript@latest` — the repo intentionally pins TS6 for typescript-eslint while compiling with TS7.
- The `@shared` / `@` path aliases exist only in the Renderer TypeScript project (`tsconfig.web.json`) and Vitest; Main, Preload, and Runtime code must use relative imports.
- Never import Node.js, Electron, or native APIs in Renderer code (see Architecture boundaries below).
- Never bypass the structured IPC request contract with arbitrary shell commands (see Architecture boundaries below).
- Do not edit `package-lock.json` or the `packageManager` field by hand.

## Skills

Detailed playbooks live under `.agents/skills/` (`build`, `competitors`, `debug`, `performance`, `project-architecture`, `quality-check`, `release`, `test`). `.claude/skills` is a compatibility symlink to the same canonical directory. Use the skills for step-by-step workflows beyond this summary.

## Architecture boundaries

- Renderer code never imports Node.js, Electron, PTY, Git, or filesystem APIs.
- The preload exposes only the typed `window.caxri` allowlist from `src/shared/ipc`, whose method table, domain schemas, event union, and error taxonomy are the single source of truth for both processes.
- Sanctioned exception: the Process Explorer diagnostic window uses its own dedicated preload bridge and IPC channels (`src/shared/process-explorer-channels.ts`); it is read-only diagnostics and must not grow project/session/file operations — those belong to the structured `window.caxri` contract.
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
- Prefer asynchronous Node.js APIs (`node:fs/promises`, promisified `child_process`) over `*Sync` variants in Main, Runtime, and tooling code; test code is exempt and may use `*Sync` APIs for brevity. Elsewhere, a deliberately synchronous boundary (better-sqlite3 by design, strict startup ordering) needs a comment justifying it.
- Prefer JSDoc for non-obvious lifecycle/security behavior and document why a workaround exists.
- Keep the editor intentionally narrow: open/edit/save/in-file search/diff only.
- Style the Renderer with Tailwind v4 utilities backed by the semantic runtime theme tokens. Color utilities must reference tokens only (`bg-surface`, `text-muted`); the default palette is unregistered, and literal color utilities are forbidden. See the styling principle in `DESIGN.md`.
- Preserve the explicit external-change rule: disk changes replace dirty editor buffers without prompting.
- Read Agent state only through capability-detected metadata indexes; never parse transcripts for UI metadata or write third-party Agent state.
- Let the first Agent Terminal own the Session title, and keep the Info inspector scoped to Terminals actually started in that Session.
- Use structured argv arrays for Git and PTY launches; never concatenate an untrusted command string.
- Keep unit and integration tests with their source domain: Renderer code keeps tests beside their source files; Main, Runtime, and shared code use a `__tests__/` directory per domain. Reserve `e2e/` for full Electron workflows.
- Keep every JavaScript and TypeScript code file at or below 800 physical lines; split cohesive modules before they exceed the ESLint `max-lines` gate.
- Keep root `DESIGN.md` focused on frontend and UI design. Update the `project-architecture` skill references, tests, and these commands when an architecture or toolchain contract changes.

## Testing workflow

- During implementation, run only tests affected by the changed source files. Do not run `bun run test` or `bun run test:e2e` as a routine iteration step.
- Prefer `bun run check <changed files>` for the default post-edit pass; use `--lint --test --type` when a shared TypeScript contract changes.
- Run focused Vitest files with `bunx vitest run --silent='passed-only' <test-file...>`.
- Run focused Electron coverage with `bunx playwright test <e2e-file> --reporter=line`; use `-g '<test name>'` when only one workflow changed.
- Finish source edits before updating tests. For a bug fix, first add or identify a behavior-level regression that fails for the bug and passes after the fix.
- Do not unit-test React components by default. When component logic needs coverage, extract it into a hook or pure function and test that; rendering and interaction belong to the smallest relevant E2E workflow.
- Prefer observable output and integration boundaries over internal call assertions. Mock Electron IPC or native boundaries for unit tests; reserve a real Electron launch for the smallest relevant E2E workflow.
- Run the full unit or E2E suite only for release/CI parity, when explicitly requested, or when a shared cross-cutting contract makes the focused scope insufficient. This applies doubly to implementation subagents: an orchestrator must scope each subagent to the specs covering its change (`bunx playwright test <file> [-g '<name>']`) instead of handing every task the full `bun run test:e2e` gate.

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

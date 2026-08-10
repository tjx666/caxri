# Caxri contributor guide

## Commands

- Install dependencies: `ni`
- Start the Electron app: `bun run dev`
- Format the whole repository: `bun run format`; verify formatting: `bun run format:check`. Appending
  file paths does not narrow `bun run format`; use `bunx --bun prettier --write <files...>` for a
  focused formatting pass.
- Format Markdown: `bun run format:md`; verify formatting: `bun run format:md:check`
- Focused changed-file validation: `bun run check [files...] [--lint] [--test] [--type] [--knip] [--staged]`
- Validate locally: `bun run lint`, `bun run typecheck`, `bun run test`; run the full `bun run test:e2e` suite only in GitHub Actions except for the guarded Go fallback defined below.
- CI-blocking gates with no local wrapper elsewhere: `bun run knip` (dead code/exports) and `bun run doctor` (React health). Run `knip` (or `check --knip`) before pushing renderer or shared-contract changes; `doctor` is slower and usually left to CI.
- `package.json` pins `packageManager` to npm for electron-builder's `install-app-deps` native rebuilds; day-to-day commands still use `ni` and `bun run`.
- Cheap post-change smoke gate (~30s Electron launch): `bun run test:smoke`
- Large-Project performance gate: `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:startup`
- Common editor highlight gate: `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:editor`
- Build/package: `bun run build`, `bun run package`, `bun run package:dmg`
- GitHub Release: follow `RELEASING.md`; only a pushed `main` commit whose subject exactly matches
  `release: v<package-version>` enters release CI, and the macOS release workflow runs only after
  that commit's CI checks and full E2E suite succeed.
- Native probes: `bun run spike:native`, `bun run spike:pty`, `bun run spike:agents`
- Issue tracking lives in GitHub issues (`gh issue`); titles, bodies, and comments use Simplified Chinese, while technical identifiers remain English. This project does not use Linear.

## Forbidden

- Install dependencies only with `ni`; `package-lock.json` is the only lockfile, so never run `bun install`, `pnpm install`, or `yarn`, and never commit a second lockfile.
- Never change the `typescript` / `@typescript/native` dependency aliases or run `npm i typescript@latest` — the repo intentionally pins TS6 for typescript-eslint while compiling with TS7.
- The `@shared` / `@` path aliases exist only in the Renderer TypeScript project (`tsconfig.web.json`) and Vitest; Main, Preload, and Runtime code must use relative imports.
- Never import Node.js, Electron, or native APIs in Renderer code (see Architecture boundaries below).
- Never bypass the structured IPC request contract with arbitrary shell commands (see Architecture boundaries below).
- Do not edit `package-lock.json` or the `packageManager` field by hand.

## Skills

Detailed playbooks live under `.agents/skills/`; their descriptions define when to use them.
`.claude/skills` is a compatibility symlink to the same canonical directory. Use the skills for
step-by-step workflows beyond this summary.

- Treat `$go` as an explicit, manual authorization for the project-local long-running delivery
  workflow. It may create or update in-scope GitHub issues, commit and push the working branch,
  create and update a PR, publish LobeHub Acceptance rounds, merge the accepted PR, and close its
  issues. A verified zero-step GitHub Actions payment or spending-limit failure automatically
  authorizes the exact-head local CI fallback defined below; do not ask again. It does not
  authorize destructive data operations, releases, secrets, account changes, or unrelated work.
- Caxri Acceptance has one product surface: isolated macOS Electron desktop. Command output and
  focused tests are supporting evidence only.
- User-facing Acceptance prose uses Simplified Chinese. Keep code, identifiers, paths, commands,
  branches, and commits in English.
- Treat "quick deep review" and "快速 deep-review" as quick mode: use one clean-context reviewer
  and root-agent synthesis. Run the full multi-agent workflow only for an explicit `$deep-review`,
  "full deep review", "full multi-agent review", or the final aggregate-review phase of an explicit
  `$go` run.
- When an authorized implementation exposes an obvious, narrow workflow defect in `AGENTS.md` or a
  repository skill, fix it directly in the same change instead of stopping for another approval.
  This does not authorize pushing, publishing, posting, closing issues, or other remote mutations.

## Batch execution workflow

- For a multi-issue goal, freeze the live issue set and record an acceptance matrix before editing.
  Separate already-fixed items, decision-only items, and implementation work.
- Group implementation and validation by owning layer or shared root cause. Keep issue-specific
  acceptance checks visible even when several issues share one change.
- Prefer cohesive commits with independently verifiable behavior. Follow an explicit user request
  for a single commit, but do not create a large mixed commit merely because the work arrived as one
  goal.
- Refresh issue or PR state before the final report. Do not push, close issues, or mutate remote state
  unless the user explicitly authorized it.

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

- UI strings, code, comments, docs, PR content, and commit messages use English. GitHub issue titles,
  bodies, and comments use Simplified Chinese; keep their code, identifiers, paths, and commands in
  English.
- Prefer named exports; React components under `src/` must not use default exports. Keep default exports only where a framework or module contract requires them.
- Prefer asynchronous Node.js APIs (`node:fs/promises`, promisified `child_process`) over `*Sync` variants in Main, Runtime, and tooling code; test code is exempt and may use `*Sync` APIs for brevity. Elsewhere, a deliberately synchronous boundary (better-sqlite3 by design, strict startup ordering) needs a comment justifying it.
- Prefer JSDoc for non-obvious lifecycle/security behavior and document why a workaround exists.
- Keep the editor intentionally narrow: open/edit/save/in-file search/diff only.
- Style the Renderer with Tailwind v4 utilities backed by the semantic runtime theme tokens. Color utilities must reference tokens only (`bg-surface`, `text-muted`); the default palette is unregistered, and literal color utilities are forbidden. See the styling principle in `DESIGN.md`.
- Preserve the explicit external-change rule: disk changes replace dirty editor buffers without prompting.
- Read Agent state only through capability-detected metadata indexes; never parse transcripts for UI metadata or write third-party Agent state.
- Let the first Agent Terminal own the Session title, and keep the Info inspector scoped to Terminals actually started in that Session.
- Use structured argv arrays for Git and PTY launches; never concatenate an untrusted command string.
- Keep a Runtime domain flat only while its implementation has at most two production modules. At three or more cohesive modules, move it under `src/runtime/<domain>/` with an `index.ts` boundary and a domain-local `__tests__/` directory; Runtime imports remain relative.
- Keep unit and integration tests with their source domain: Renderer code keeps tests beside their source files; Main, Runtime, and shared code use a `__tests__/` directory per domain. Reserve `e2e/` for full Electron workflows.
- Keep every JavaScript and TypeScript code file at or below 800 physical lines; split cohesive modules before they exceed the ESLint `max-lines` gate.
- Keep root `DESIGN.md` focused on frontend and UI design. Update the `project-architecture` skill references, tests, and these commands when an architecture or toolchain contract changes.

## Testing workflow

- During implementation, run only tests affected by the changed source files. Do not run `bun run test` as a routine iteration step.
- Prefer `bun run check <changed files>` for the default post-edit pass; use `--lint --test --type` when a shared TypeScript contract changes.
- Use a validation ladder: iterate with the narrowest test, then run one changed-file check after the
  source batch is complete. Re-run only gates invalidated by later edits. Rebuild before focused
  Electron E2E whenever relevant `src/` files changed after the previous build.
- Run focused Vitest files with `bunx vitest run --silent='passed-only' <test-file...>`.
- Never run the full Electron E2E suite locally (`bun run test:e2e` or an unscoped `bunx playwright test`) during an ordinary run; it can steal focus from the developer. Full E2E and release-level packaged-app validation belong in GitHub Actions. When a development change needs full coverage, follow the `test` skill's topic-branch and draft-PR workflow.
- A local full-E2E fallback is allowed only inside an explicit Go run after the current-head hosted
  jobs are verified to have failed before runner allocation for external billing or infrastructure,
  with automatic authorization for verified payment or spending-limit failures. Other
  infrastructure failures still require separate user authorization. Record the head, failure
  evidence, policy or user authorization, exact platform-neutral CI commands and results, and one
  `bun run test:e2e` result in the Go ledger. Keep the hosted check externally failed; never relabel
  it green. Code/test failures, missing required authorization, release packaging, and deployment
  are never eligible.
- Remote CI runs platform-neutral checks on Ubuntu. Its macOS full-E2E job runs only for pull
  requests and exact release commits; ordinary pushes to `main` must not consume a macOS runner.
- Run focused local Electron coverage only when the change requires it, using `bunx playwright test <e2e-file> --reporter=line`; add `-g '<test name>'` when only one workflow changed.
- Finish source edits before updating tests. For a bug fix, first add or identify a behavior-level regression that fails for the bug and passes after the fix.
- Do not unit-test React components by default. When component logic needs coverage, extract it into a hook or pure function and test that; rendering and interaction belong to the smallest relevant E2E workflow.
- Prefer observable output and integration boundaries over internal call assertions. Mock Electron IPC or native boundaries for unit tests; reserve a real Electron launch for the smallest relevant E2E workflow.
- A visual regression must make the failure observable, not merely assert that an element exists. For
  Terminal inset or background bugs, deliberately use contrasting application and Terminal theme
  colors so uncovered pixels cannot pass unnoticed.
- Run the full unit suite locally only for release/CI parity, when explicitly requested, or when a shared cross-cutting contract makes the focused scope insufficient. Implementation subagents must stay scoped to the specs covering their change (`bunx playwright test <file> [-g '<name>']`) and must never receive the full `bun run test:e2e` gate.

Keep successful validation output compact. Preserve complete logs in a task-scoped file when useful,
surface the actionable summary, and expand the underlying tool output only on failure or when the
user asks for it.

### Scripted repro

Launch Caxri headlessly, without the interactive directory picker, using environment variables read in `src/main/index.ts` and `src/main/test-root.ts`:

- `CAXRI_E2E=1` selects test mode.
- `CAXRI_USER_DATA_DIR=<tmpdir>` isolates Electron's user-data directory from a developer's real profile.
- `CAXRI_TEST_ROOT_PATH=<dir>` stubs the directory-picker grant with a fixed Project root (see `src/main/test-root.ts`); only honored when `CAXRI_E2E=1` and the app is unpackaged.
- `CAXRI_TEST_ROOT_PATHS=<JSON array>` queues multiple deterministic directory-picker roots for
  multi-Project tests; the Acceptance adapter sets it when `--test-root` is repeated.

Structured logs land in `logs/main.jsonl` and `logs/runtime.jsonl` in development; packaged/test launches write under the active Electron user-data directory instead.

## Performance and observability

- Keep Runtime, Terminal, file tree, and single- or multi-repository Git startup below the three-second large-Project gate.
- Coalesce concurrent expensive reads and probes; React StrictMode must not duplicate native work.
- Send live PTY output only to attached Renderer views, and restore snapshots before replaying output buffered during attachment.
- Log timings at operation boundaries. Aggregate high-frequency PTY metrics instead of writing one log record per input, resize, or output event.
- Performance changes must include a focused regression test or a benchmark assertion.
- Development logs are written to `logs/main.jsonl` and `logs/runtime.jsonl`; packaged builds use the Electron user-data directory.

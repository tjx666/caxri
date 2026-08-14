# Caxri contributor guide

## Commands

- Install dependencies: `ni`
- Start the Electron app in the current worktree: `bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev`
- Manage isolated worktrees: explicitly invoke `$switch-worktree`; its CLI creates adjacent
  `caxri-worktrees/` checkouts, runs `ni` per checkout, and owns profile/process/desktop isolation.
- Format the whole repository: `bun run format`; verify formatting: `bun run format:check`. Appending
  file paths does not narrow `bun run format`; use `bun run --silent check <files...> --lint` for a focused
  ESLint and Prettier pass with compact successful output.
- Format Markdown: `bun run format:md`; verify formatting: `bun run format:md:check`
- Focused changed-file validation: `bun run --silent check [files...] [--lint] [--test] [--type] [--knip] [--e2e] [--e2e-grep '<pattern>'] [--staged]`
- Validate locally: `bun run lint`, `bun run typecheck`, `bun run test`; run the full `bun run test:e2e` suite only in GitHub Actions except for the guarded Go fallback defined below.
- CI-blocking gates with no local wrapper elsewhere: `bun run knip` (dead code/exports) and `bun run doctor` (React health). Run `knip` (or `check --knip`) before pushing renderer or shared-contract changes; `doctor` is slower and usually left to CI.
- `package.json` pins `packageManager` to npm for electron-builder's `install-app-deps` native rebuilds; day-to-day commands still use `ni` and `bun run`.
- Build or validate the browser-safe protocol and Node-only CLI workspaces with
  `bun run build:workspaces`, `bun run typecheck:workspaces`, and `bun run test:workspaces`;
  root `build`, `typecheck`, and `test` retain those checks.
- Cheap post-change smoke gate (~30s Electron launch): `bun run --silent test:smoke`
- Self-hosted CI and Release runner operation and recovery: `docs/self-hosted-runner.md`; every
  GitHub Actions job uses `m2-24`, and there is no GitHub-hosted fallback.
- Large-Project performance gate: `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:startup`
- Common editor highlight gate: `CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:editor`
- Build/package: `bun run build`, `bun run package`, `bun run package:dmg`; for a locally requested
  versioned installer, use
  `bun run .agents/skills/release/scripts/package-local-dmg.ts --version <semver>` so temporary
  manifest changes are restored and the DMG is verified.
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
- Keep `packages/protocol` browser-safe and keep Electron, SQLite, PTY, watcher, and other Desktop
  native dependencies out of `packages/cli`'s production dependency graph.
- Keep `packages/protocol/src` grouped by its `agent`, `configuration`, `desktop`, `domain`,
  `registry`, and `transport` boundaries. External consumers use the package root; compatibility
  re-exports under `src/shared` may target the owning domain module directly.

## Skills

Detailed playbooks live under `.agents/skills/`; their descriptions define when to use them.
`.claude/skills` is a compatibility symlink to the same canonical directory. Use the skills for
step-by-step workflows beyond this summary.

- Treat `$go` as an explicit, manual authorization for the project-local long-running delivery
  workflow. It may create or update in-scope GitHub issues, commit and push the working branch,
  create and update a PR, publish LobeHub Acceptance rounds, merge the accepted PR, and close its
  issues. It does not authorize bypassing failed or queued CI, destructive data operations,
  releases, secrets, account changes, or unrelated work.
- Start a new `$go` run through `.agents/skills/go/scripts/start.ts`: it pins the latest
  `origin/main`, creates a dedicated adjacent worktree, and records that worktree in the ledger.
  Resume in the recorded worktree; keep the main checkout branch, HEAD, and working tree unchanged.
- A Go ledger permits one aggregate full deep review. Later code changes require an exact-lineage
  light delta review; CI, fixture, evidence, gates, and remote-state checks are validation records,
  not additional review rounds. Persist and deliver the exact-head handoff report before waiting
  for human Acceptance, and require a delivered finalization receipt before completion.
- Before completing a Go issue, explicitly assess whether implementation or evidence materially
  differs from its public expectation. Publish material drift as a structured Simplified Chinese
  issue comment; unresolved, unpublished, or stale assessments block PR readiness and finalization.
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
- The preload exposes only the typed `window.caxri` allowlist backed by `packages/protocol`, whose
  method table, domain schemas, principal projections, event union, and error taxonomy are the
  transport-neutral single source of truth. `src/shared/ipc` contains compatibility re-exports and
  Electron adapters only; do not add a second contract there.
- Sanctioned exception: the Process Explorer diagnostic window uses its own dedicated preload bridge and IPC channels (`src/shared/process-explorer-channels.ts`); it is read-only diagnostics and must not grow project/session/file operations — those belong to the structured `window.caxri` contract.
- Main owns windows, native dialogs, Desktop lifecycle, and its authenticated Host lease.
- Headless Host owns the profile lock, command/event transport, and exactly one Runtime child.
- Runtime owns SQLite, PTYs, Git, files/watchers, settings, themes, adapters, and diagnostics.
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
- Read Agent state only through capability-detected metadata indexes; never parse transcripts for UI metadata or write third-party Agent state. The sole write exception is an explicitly enabled provider lifecycle-hook adapter: it may atomically maintain only Caxri-marked entries in that provider's documented user hook file, must preserve foreign entries, and must leave newer Caxri schemas untouched.
- Let the first Agent Terminal own the Session title, and keep the Info inspector scoped to Terminals actually started in that Session.
- Use structured argv arrays for Git and PTY launches; never concatenate an untrusted command string.
- Keep a Runtime domain flat only while its implementation has at most two production modules. At three or more cohesive modules, move it under `src/runtime/<domain>/` with an `index.ts` boundary and a domain-local `__tests__/` directory; Runtime imports remain relative.
- Keep unit and integration tests with their source domain: Renderer code keeps tests beside their source files; Main, Runtime, and shared code use a `__tests__/` directory per domain. Reserve `e2e/` for full Electron workflows.
- Keep every JavaScript and TypeScript code file at or below 800 physical lines; split cohesive modules before they exceed the ESLint `max-lines` gate.
- Keep root `DESIGN.md` focused on frontend and UI design. Update the `project-architecture` skill references, tests, and these commands when an architecture or toolchain contract changes.

## Testing workflow

- During implementation, run only tests affected by the changed source files. Do not run `bun run test` as a routine iteration step.
- Prefer `bun run --silent check <changed files>` for the default post-edit pass; use `--lint --test --type` when a shared TypeScript contract changes.
- Use a validation ladder: iterate with the narrowest test, then run one changed-file check after the
  source batch is complete. Re-run only gates invalidated by later edits. Rebuild before focused
  Electron E2E whenever relevant `src/` files changed after the previous build.
- Run focused Vitest files with `bunx vitest run --silent='passed-only' <test-file...>`.
- Focused `--test` selection combines bounded colocated/domain candidates with static direct-import
  suites. It does not follow dynamic or transitive imports into broad composition-root tests.
- Never run the full Electron E2E suite locally (`bun run test:e2e` or an unscoped `bunx playwright test`) during an ordinary run; it can steal focus from the developer. Full E2E and release-level packaged-app validation belong in GitHub Actions. When a development change needs full coverage, follow the `e2e-testing` skill's topic-branch and draft-PR workflow.
- A local full-E2E substitution is allowed only inside an explicit Go run after the current-head
  self-hosted Actions jobs are verified to have failed before execution for external GitHub Actions
  infrastructure, with separate user authorization. Record the head, failure evidence,
  authorization, exact platform-check commands and results, and one `bun run test:e2e` result in
  the Go ledger. Keep the Actions check externally failed; never relabel it green. Code/test
  failures, missing authorization, release packaging, and deployment are never eligible.
- Every remote CI and Release job runs on the repository self-hosted Apple Silicon `m2-24` runner.
  Platform checks and the final gate use `caxri-ci`, full Electron E2E uses `caxri-e2e`, and Release
  packaging uses `caxri-release`. There is no GitHub-hosted fallback. Ordinary trusted pushes to
  `main` run checks but not full E2E; exact release commits and trusted ready PRs run full E2E.
- Full E2E uses one setup/build and then runs the `parallel-safe` and `desktop-exclusive` logical
  pools sequentially. A failed first pool must not suppress the second; actual-execution receipts
  and failure artifacts remain scoped per pool.
- Run focused local Electron coverage only when the change requires it, using
  `bun run --silent check <e2e-file> --e2e`; add `--e2e-grep '<test name>'` when only one workflow changed.
  The checker builds first and collapses successful build and Playwright output into one summary.
- Every Electron spec imports `test` and `expect` from `e2e/support/fixtures.ts`, never directly from
  `@playwright/test`. The automatic fixture treats Renderer exceptions/console errors and
  structured Host/Main/Runtime error events as failures and attaches all JSONL logs before a temporary
  user-data directory can be removed.
- A scenario that deliberately produces an error must call `allowE2EErrors(...)` with an exact
  `source`/`event`/`code`/`count` tuple. Wildcards, message matching, duplicate allowances, and
  allowances that are not consumed all fail the test.
- Focused Electron E2E launches use hidden native windows by default. A spec that verifies native focus or pointer behavior must pass `windowMode: 'visible'`; the Acceptance adapter always does so for the real desktop surface.
- Acceptance plans default every case to an isolated profile. Run each state-mutating case in a
  separately named launch; only a declared restart case may reuse one validated temp profile, and
  its final launch owns cleanup. Terminal/visual fixtures must pass the cell-width/grid/generation
  preflight before recording. Go-owned rounds publish only through the exact-lineage wrapper, not a
  raw `lobehub acceptance run ingest` command.
- For a CI-only timing failure, reproduce only the exact failed cases against the production
  build with one worker and `--repeat-each=3`. Make slowness deterministic at the owning async
  boundary or wait for an observable product invariant; preserve relevant CI viewport and temporary
  path conditions. If the failure came from `parallel-safe`, also reproduce the exact specs through
  the same namespaced two-worker pool before pushing. Do not rely on machine-wide throttling or a
  timeout-only fix.
- Treat self-hosted Actions CI as a final validator, not an implementation loop. Download the first red run's
  artifacts, collect all failures on that head, finish and locally validate the complete repair
  batch, then push once. For an eligible unprotected delta use exact-tree `e2e-repair`; protected CI,
  dependency, pool, fixture, or workflow changes remain fail-closed and require one final full run.
- Electron E2E helpers, Acceptance, and performance benchmarks acquire one repository-wide desktop
  lease before launch. Never bypass their launch helpers or run a second desktop task concurrently;
  use `$switch-worktree`'s `desktop` command for any additional Electron desktop workflow.
- Finish source edits before updating tests. For a bug fix, first add or identify a behavior-level regression that fails for the bug and passes after the fix.
- Do not unit-test React components by default. When component logic needs coverage, extract it into a hook or pure function and test that; rendering and interaction belong to the smallest relevant E2E workflow.
- Prefer observable output and integration boundaries over internal call assertions. Mock Electron IPC or native boundaries for unit tests; reserve a real Electron launch for the smallest relevant E2E workflow.
- A visual regression must make the failure observable, not merely assert that an element exists. For
  Terminal inset or background bugs, deliberately use contrasting application and Terminal theme
  colors so uncovered pixels cannot pass unnoticed.
- Run the full unit suite locally only for release/CI parity, when explicitly requested, or when a shared cross-cutting contract makes the focused scope insufficient. Implementation subagents must stay scoped to the specs covering their change (`bun run --silent check <file> --e2e [--e2e-grep '<name>']`) and must never receive the full `bun run test:e2e` gate.

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
- Shared E2E launch helpers default Agent discovery to `blocked` and isolate provider state beneath
  the test user-data directory. Agent specs must explicitly select a shared `fake` fixture or the
  single-provider `real` mode, except negative tests that deliberately prove the `blocked` default;
  never rely on a developer's `PATH`, `HOME`, `CODEX_HOME`, or `CLAUDE_CONFIG_DIR` by accident.
- The real-Agent smoke is manual and Codex-only: run `bun run test:e2e:real-agent`. It requires an
  authenticated Codex CLI, sends one bounded natural-language read-only prompt in a temporary
  Project, disables screenshots/traces, and never falls back to another provider.

Structured logs land in `logs/host.jsonl`, `logs/main.jsonl`, and `logs/runtime.jsonl` in development; packaged/test launches write under the active Electron user-data directory instead.

## Performance and observability

- Keep Runtime, Terminal, file tree, and single- or multi-repository Git startup below the three-second large-Project gate.
- Coalesce concurrent expensive reads and probes; React StrictMode must not duplicate native work.
- Send live PTY output only to attached Renderer views, and restore snapshots before replaying output buffered during attachment.
- Log timings at operation boundaries. Aggregate high-frequency PTY metrics instead of writing one log record per input, resize, or output event.
- Performance changes must include a focused regression test or a benchmark assertion.
- Development logs are written to `logs/host.jsonl`, `logs/main.jsonl`, and `logs/runtime.jsonl`; packaged builds use the Electron user-data directory.

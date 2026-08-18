# Caxri contributor guide

## Repository layout

| Path        | Purpose                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `src/`      | Electron Host, Main, Preload, Renderer, Runtime, and shared Desktop source |
| `packages/` | Browser-safe protocol, shared pure-utility, and standalone CLI workspaces  |
| `e2e/`      | Playwright Electron workflows and shared desktop fixtures                  |
| `scripts/`  | Repository-wide CI, validation, benchmark, and runner tooling              |
| `.agents/`  | Canonical contributor skills; `.claude/skills` is a compatibility symlink  |
| `skills/`   | Product skill embedded in and distributed with the Caxri CLI               |
| `build/`    | Tracked packaging inputs, including icons and the CLI launcher             |
| `docs/`     | Durable product, module, operator, and architecture-debt documentation     |
| `licenses/` | Vendored third-party license texts                                         |

Generated or local-only roots such as `out/`, `release/`, `logs/`, `test-results/`, `.records/`,
`competitors/`, and `node_modules/` are intentionally gitignored and are not source directories.

## Agent-native development

- Caxri is developed exclusively by coding agents using frontier models and agent harnesses such
  as Codex, Claude Code, and Grok Build. Optimize the repository for autonomous agent discovery,
  execution, verification, and recovery.
- Estimate scope and development cost in agent-native terms: ambiguity, architectural reach,
  ownership boundaries, validation requirements, desktop or CI constraints, and expected agent
  iterations. Do not use traditional manual implementation time or hand-written code volume as the
  default cost baseline unless the user explicitly asks for it.
- After completing each user request, briefly assess what in the execution workflow should become
  reusable. When the improvement is concrete and broadly useful, extract or strengthen scripts,
  guards, tests, `AGENTS.md` guidance, or task-routed skills so future agents can execute the same
  work more reliably. Avoid speculative process churn that has no demonstrated reuse case.
- When an authorized implementation exposes an obvious, narrow defect in `AGENTS.md` or a repository
  skill, repair it in the same change. This does not grant unrelated or remote mutation authority.
- Before designing or implementing a substantial new product feature, load the `competitors` skill
  and research how existing products solve it — direct competitors as well as the reference
  implementations the skill lists (VS Code for editor-grade surfaces such as source control,
  extensions, keybindings, and theming; GitLens for blame, history, and richer Git UX) — instead
  of inventing a new interaction pattern first.
- Use `docs/` for durable explanations of shipped behavior, core modules, protocols, architectural
  decisions, and operator knowledge. After completing a core module or a large feature, explicitly
  assess whether its lasting design or operational knowledge should be documented there.
- Use `.agents/skills/` for agent-discoverable, task-routed execution workflows and the project
  architecture or toolchain contracts an agent must load to work safely. Keep reusable automation
  beside its owning skill and keep each skill description specific enough for reliable routing.
- When a difficult, ambiguous, or costly decision would benefit from an independent perspective,
  use `dianjiang` to consult another agent harness. Keep consultations read-only unless the current
  request explicitly authorizes the same scoped mutation, treat the result as evidence, and keep
  final adjudication with the primary agent against current repository state.
- Delegate bounded discovery, review, and validation work to context-isolated subagents when that
  reduces primary-context pollution, latency, or token cost. Pass only the required artifacts and
  constraints, prefer faster and cheaper presets for well-scoped tasks, and synthesize their results
  in the primary agent before acting. Never run Electron desktop tasks concurrently; additional
  desktop work must use the repository's isolated worktree and desktop-lease workflow.
- A request to review current local work authorizes the primary agent to repair validated P0/P1
  findings introduced by that work when the fix is unambiguous, local, and inside the requested
  scope. This applies to direct review, `deep-review`, and `dianjiang` review. Keep delegated
  reviewers read-only and let the primary agent own edits and validation. Stop for discussion when
  multiple product choices are reasonable, the fix expands scope, or it requires destructive or
  remote mutation; honor an explicit read-only or report-only request.

## Current development status

- Caxri currently has a single human maintainer (the repository owner), who usually runs multiple
  coding-agent sessions in parallel. Expect sibling sessions to be changing the repository at the
  same time as yours.
- Small fixes and minor features are sometimes committed directly on `main` and pushed without a
  pull request, so `main` and remote branches can move at any moment.
- When you encounter commits you did not author — after a branch switch, fetch, rebase, or a PR
  merge — treat the newest commits as authoritative by default: rebase or merge onto them and
  resolve conflicts in favor of the latest state, rather than stopping to ask or discarding the
  unfamiliar work. Escalate only when the conflict implies a real design disagreement that cannot
  be resolved mechanically.

## Commands

- Install dependencies: `ni`
- Start the Electron app in the current worktree:
  `bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev`
- Every unpackaged (dev) launch exposes CDP at `127.0.0.1:9223` and packaged (production) builds
  expose `127.0.0.1:9224` by default during internal testing (`CAXRI_DEV_CDP_PORT` overrides
  either). The `debug` skill owns the live-inspection workflow, including the mandatory
  proxy-variable workaround for `agent-browser connect` and the raw-CDP fallback.
- Unpackaged (dev) launches default to an isolated `caxri-dev` userData profile (own Host, SQLite,
  and logs) so they never contend with the installed production app; `CAXRI_USER_DATA_DIR`
  overrides it (`src/main/user-data.ts`).
- Manage isolated worktrees by explicitly invoking `$switch-worktree`.
- Format the repository: `bun run format`; verify formatting: `bun run format:check`
- Format Markdown: `bun run format:md`; verify formatting: `bun run format:md:check`
- Focused changed-file validation:
  `bun run --silent check [files...] [--lint] [--test] [--type] [--knip] [--e2e]`
- Repository-wide local gates: `bun run lint` (syntactic ESLint), `bun run lint:type-aware`
  (oxlint/tsgolint type-aware rules — see `docs/type-aware-linting.md`), `bun run typecheck`, and
  `bun run test`
- Watch a GitHub Actions run to completion: `bun run scripts/watch-ci.ts [--run <id>]`
  (defaults to the newest run on the current branch). Run it in a background shell by default so
  the session keeps working while the watch reports asynchronously. Sessions watching the same
  run — including sessions in different worktrees — share one GitHub poller through the user-level
  `~/.cache/caxri/ci-watch/`, failed jobs raise an immediate macOS notification, and polling
  survives offline windows with capped backoff. Exits 0/1 with the run conclusion.
- Preview the pre-release local reset/uninstall plan: `bun run uninstall:caxri`; apply it only after
  explicit authorization with `bun run uninstall:caxri -- --yes`. The command archives known Caxri
  installation state, application paths, and managed development profiles beneath
  the primary checkout's sibling `../caxri-uninstall-archives`, records every original path in
  `manifest.json`, and never targets Project directories or user files.
- Issue tracking lives in GitHub issues (`gh issue`); titles, bodies, and comments use Simplified
  Chinese while technical identifiers remain English. This project does not use Linear.

## Forbidden

- Do not push, close issues, merge pull requests, or otherwise mutate remote state unless the user
  or an explicitly active workflow authorizes that exact scope. Refresh remote state before the
  final report after any authorized mutation.
- Install or update local dependencies only with `ni`; `pnpm-lock.yaml` is the only lockfile. Never
  run `bun install`, `npm install`, or `yarn`, and never commit a second lockfile. Direct
  `pnpm install --frozen-lockfile` is reserved for the documented CI/frozen-install verification.
- Never change the `typescript` / `@typescript/native` dependency aliases or run
  `npm i typescript@latest`; the repository intentionally pins TS6 for typescript-eslint while
  compiling with TS7.
- The `@shared` / `@` path aliases exist only in the Renderer TypeScript project
  (`tsconfig.web.json`) and Vitest; Main, Preload, and Runtime code must use relative imports.
- Never import Node.js, Electron, or native APIs in Renderer code.
- Never bypass the structured IPC request contract with arbitrary shell commands.
- Do not edit `pnpm-lock.yaml` by hand. Do not add `packageManager` or
  `devEngines.packageManager`; `mise.toml` and the explicit GitHub Actions setup own tool versions.
- Keep `packages/protocol` browser-safe and keep Electron, SQLite, PTY, watcher, and other Desktop
  native dependencies out of `packages/cli`'s production dependency graph.
- Keep `packages/utils` browser-safe and free of runtime dependencies; it holds pure functions
  only. Domain types, protocol schemas, and React code never move there.
- Keep `packages/protocol/src` grouped by its `agent`, `configuration`, `desktop`, `domain`,
  `registry`, and `transport` boundaries. External consumers use the package root; compatibility
  re-exports under `src/shared` may target the owning domain module directly.
- Keep `packages/cli/src` grouped by its `commands`, `host`, and `skills` boundaries. The package
  root remains the composition root (`application`, `environment`, `output`, `selectors`) and the
  only public package entrypoint. Domain barrels stay thin; tests live in domain-local `__tests__/`
  directories.

## Compatibility policy

- Until Caxri has a public release, optimize for the current architecture instead of preserving
  compatibility with previous local builds. Do not add protocol adapters, legacy Host controls,
  dual-read/write paths, or migration UI only to keep an unpublished build running; fail clearly
  and direct the operator to a documented reset or reinstall workflow.
- Database schema migrations remain allowed during active development so the current working data
  can evolve safely and upgrade behavior stays exercised. Do not treat schema migrations as a
  reason to preserve unrelated runtime, Host protocol, CLI, or UI compatibility layers.
- Before the public compatibility commitment, the owner may declare an explicit clean-install
  cutoff: squash or remove pre-release schema migrations and legacy compatibility code, verify the
  destructive reset/uninstall tooling, and require a reinstall. Never infer this cutoff or delete
  local data without explicit user authorization.
- After a public release, backward compatibility becomes a product contract. Removing migrations
  or compatibility paths then requires an explicit release policy, a supported upgrade path, and
  validation against already released versions.

## Architecture guardrails

- Validate filesystem paths against the selected Session's authorized Project root. Git may access
  another linked repository only when its root is covered by an explicitly added Project.
- A Project owns one local root; Sessions reference the Project by ID and cannot submit a root path.
- Project and Session deletion remove metadata only. They must never remove the Project directory or
  user files.
- Diagnostics must exclude source contents, Terminal output and snapshots, Agent transcripts,
  credentials, environment values, and secret-like settings.

## Verification before reporting done

- A user-visible Renderer/UI change is not done until it has been verified visually in the running
  dev app: drive the real application over CDP (the `debug` skill owns the workflow), capture a
  screenshot of the affected surface, and check it before reporting completion. Passing unit or
  e2e gates alone does not count for visual changes.
- The dev Host and Runtime are long-lived background processes that survive window restarts, so a
  running dev instance can silently execute stale code. Before using a live instance to verify or
  disprove a Main/Runtime change, confirm the `out/main/host.js` / `out/main/runtime.js` process
  start times postdate the change (`ps -axo pid,lstart,command`), and restart them when they do not.
- Reproduce a reported bug before changing code: demonstrate the failure against the current build
  (a failing test, or the live app plus its on-disk state) so the fix targets the verified cause
  rather than the first plausible suspect.

## Testing requirements

- New features ship with behavior-level tests for the functionality they add, at the narrowest
  owning surface: Vitest unit/integration coverage (`unit-testing`) for logic below the desktop
  boundary, Playwright workflows (`e2e-testing`) only for user-visible Electron behavior; the
  `e2e-testing` skill owns the criteria for when a behavior earns an Electron workflow.
- Bug fixes land with a regression test that reproduces the defect and fails without the fix, in
  the same commit. When the fix sits above a testable boundary, extract the logic so the failure
  mode is testable rather than skipping the test.
- React UI rendering is not unit-tested: no render/snapshot tests against `.tsx` components.
  Extract the logic worth testing into hooks or plain modules and test those; rendering and
  interaction are validated only through the `e2e-testing` Playwright workflows.
- Existing untested modules are debt, not precedent. Touching an untested area does not require
  backfilling its whole suite, but the behavior you add or change there must be covered.

## Code conventions

- UI strings, code, comments, docs, PR content, and commit messages use English. GitHub issue titles,
  bodies, and comments use Simplified Chinese; keep their code, identifiers, paths, and commands in
  English.
- Prefer named exports; React components under `src/` must not use default exports. Keep default
  exports only where a framework or module contract requires them.
- All JavaScript/TypeScript files use kebab-case basenames, components and hooks included; the
  primary export keeps its semantic casing (e.g. `file-tree-panel.tsx` exports `FileTreePanel`).
  `.agents/skills/source-layout/SKILL.md` is the authority for details.
- Prefer asynchronous Node.js APIs (`node:fs/promises`, promisified `child_process`) over `*Sync`
  variants in Main, Runtime, and tooling code; test code is exempt. A deliberately synchronous
  production boundary needs a comment justifying it.
- Prefer JSDoc for non-obvious lifecycle or security behavior and document why a workaround exists.
- Generic helpers come from `es-toolkit` first; never hand-roll a function it already ships. What
  it lacks goes to the shared layers instead of a feature-local copy: browser-safe dependency-free
  pure functions in `@caxri/utils` (`packages/utils`), cross-feature React hooks in
  `src/renderer/src/hooks` (`@/hooks`). Feature directories hold feature-specific logic only.
- Coding agents reproduce the dominant precedent they see in neighboring code, so exemplar hygiene
  is a maintenance duty: when a shared implementation replaces local copies, migrate every call
  site in the same change, and never leave two coexisting ways of doing the same thing — the old
  pattern keeps propagating for as long as it remains visible.
- Style the Renderer with Tailwind v4 utilities backed by semantic runtime theme tokens. Color
  utilities must reference tokens only (`bg-surface`, `text-muted`); the default palette is
  unregistered, and literal color utilities are forbidden. See `DESIGN.md`.
- Use structured argv arrays for Git and PTY launches; never concatenate an untrusted command string.
- Keep every JavaScript and TypeScript code file at or below 800 physical lines; split cohesive
  modules before they exceed the ESLint `max-lines` gate.

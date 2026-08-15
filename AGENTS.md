# Caxri contributor guide

## Repository layout

| Path        | Purpose                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `src/`      | Electron Host, Main, Preload, Renderer, Runtime, and shared Desktop source |
| `packages/` | Browser-safe protocol and standalone CLI workspaces                        |
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

## Commands

- Install dependencies: `ni`
- Start the Electron app in the current worktree:
  `bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev`
- Every unpackaged (dev) launch exposes CDP at `127.0.0.1:9223` (`CAXRI_DEV_CDP_PORT` overrides)
  for live DOM inspection and screenshots, e.g. `agent-browser connect --port 9223`.
- Manage isolated worktrees by explicitly invoking `$switch-worktree`.
- Format the repository: `bun run format`; verify formatting: `bun run format:check`
- Format Markdown: `bun run format:md`; verify formatting: `bun run format:md:check`
- Focused changed-file validation:
  `bun run --silent check [files...] [--lint] [--test] [--type] [--knip] [--e2e]`
- Repository-wide local gates: `bun run lint`, `bun run typecheck`, and `bun run test`
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

## Code conventions

- UI strings, code, comments, docs, PR content, and commit messages use English. GitHub issue titles,
  bodies, and comments use Simplified Chinese; keep their code, identifiers, paths, and commands in
  English.
- Prefer named exports; React components under `src/` must not use default exports. Keep default
  exports only where a framework or module contract requires them.
- Prefer asynchronous Node.js APIs (`node:fs/promises`, promisified `child_process`) over `*Sync`
  variants in Main, Runtime, and tooling code; test code is exempt. A deliberately synchronous
  production boundary needs a comment justifying it.
- Prefer JSDoc for non-obvious lifecycle or security behavior and document why a workaround exists.
- Style the Renderer with Tailwind v4 utilities backed by semantic runtime theme tokens. Color
  utilities must reference tokens only (`bg-surface`, `text-muted`); the default palette is
  unregistered, and literal color utilities are forbidden. See `DESIGN.md`.
- Use structured argv arrays for Git and PTY launches; never concatenate an untrusted command string.
- Keep every JavaScript and TypeScript code file at or below 800 physical lines; split cohesive
  modules before they exceed the ESLint `max-lines` gate.

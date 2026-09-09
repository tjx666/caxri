# Caxri contributor guide

This file is the always-on standing orders. Task procedures, architecture contracts, and toolchain
recipes live in `.agents/skills/` — load the owning skill instead of restating it here.

## Repository layout

| Path          | Purpose                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `apps/`       | Independently runnable Desktop, Server, and CLI workspaces                                      |
| `packages/`   | Importable Client, protocol, Extension API, Agent skills, system primitives, and pure utilities |
| `extensions/` | Bundled native ESM extensions and their packaging inputs                                        |
| `e2e/`        | Playwright Electron workflows and shared desktop fixtures                                       |
| `scripts/`    | Repository-wide CI, validation, benchmark, and runner tooling                                   |
| `tools/`      | Vendored contributor tooling loaded by repository checks                                        |
| `.agents/`    | Canonical contributor skills; `.claude/skills` is a compatibility symlink                       |
| `skills/`     | Product skill embedded in and distributed with the Caxri CLI                                    |
| `build/`      | Tracked packaging inputs, including icons and the CLI launcher                                  |
| `docs/`       | Durable product, module, operator, and architecture-debt documentation                          |
| `licenses/`   | Vendored third-party license texts                                                              |

Generated or local-only roots such as `out/`, `release.noindex/`, `logs/`, `test-results/`,
`.records/`, `competitors/`, and `node_modules/` are gitignored on purpose. They are not source
directories.

## Operating model

- Caxri is developed exclusively by coding agents, using frontier models and harnesses such as
  Codex, Claude Code, and Grok Build. Optimize the repository for autonomous discovery, execution,
  verification, and recovery.
- Estimate scope and cost in agent-native terms: ambiguity, architectural reach, ownership
  boundaries, validation requirements, desktop or CI constraints, and expected agent iterations.
  Traditional manual implementation time and hand-written code volume are not the default baseline
  unless the user explicitly asks for them.
- When completed work reveals a concrete, demonstrated, broadly useful workflow improvement,
  extract or strengthen scripts, guards, tests, this file, or the owning skill when the change is
  safe, reversible, authorized, and in scope. Raise it for discussion only when a real product
  choice, new authority, or material scope expansion requires the user's decision. Do not invent
  process for a reuse case you have not demonstrated.
- When an authorized implementation exposes an obvious, narrow defect in this file or a repository
  skill, repair it in the same change. That does not authorize unrelated or remote mutation.
- Use `docs/` for durable explanations of shipped behavior, core modules, protocols, architectural
  decisions, and operator knowledge. After a core module or large feature lands, explicitly ask
  whether its lasting design or operational knowledge belongs there.
- Use `.agents/skills/` for agent-discoverable, task-routed execution workflows and the architecture
  or toolchain contracts an agent must load to work safely. Keep reusable automation beside its
  owning skill. Keep each skill description specific enough for reliable routing.
- Contributor skill invocation follows [.agents/invocation.md](.agents/invocation.md).
- When a difficult, ambiguous, or costly decision would benefit from an independent perspective,
  use `dianjiang` to consult another agent harness. Keep the consultation read-only unless the
  current request explicitly authorizes the same scoped mutation. Treat the result as evidence.
  Final adjudication stays with the primary agent against current repository state.
- A request to review current local work authorizes the primary agent to repair validated P0/P1
  findings introduced by that work when the fix is unambiguous, local, and inside the requested
  scope. This applies to direct review, `deep-review`, and `dianjiang` review. Keep delegated
  reviewers read-only; the primary agent owns edits and validation. Stop for discussion when
  multiple product choices are reasonable, the fix expands scope, or it requires destructive or
  remote mutation. Honor an explicit read-only or report-only request.

## Current development status

- Caxri currently has a single human maintainer (the repository owner), who usually runs multiple
  coding-agent sessions in parallel. Expect sibling sessions to be changing the repository at the
  same time as yours.
- Before modifying code, use a worktree dedicated to the current session's task. If this session
  does not already have a related worktree, create and switch to one with `switch-worktree` before
  editing. This is the default even for small fixes or a clean checkout. Do not modify code
  directly on `main` or an unrelated task's branch unless the user explicitly requests it.
- With explicit user authorization, small fixes and minor features may be committed directly on
  `main` and pushed without a pull request. `main` and remote branches can move at any moment.
- When you encounter commits you did not author — after a branch switch, fetch, rebase, or a PR
  merge — treat the newest commits as authoritative by default. Rebase or merge onto them and
  resolve conflicts in favor of the latest state. Do not stop to ask, and do not discard the
  unfamiliar work. Escalate only when the conflict is a real design disagreement that cannot be
  resolved mechanically.

## Standing orders

- Do not push, close issues, merge pull requests, or otherwise mutate remote state unless the user
  or an explicitly active workflow authorizes that exact scope. After any authorized mutation,
  refresh remote state before the final report.
- Default ordinary dependency ranges to `^`. Keep exact pins or narrower ranges only for a
  documented compatibility constraint; see `.agents/skills/project-architecture/references/stack-baseline.md`
  for the current exceptions. The lockfile owns reproducible installation.
- Install or update local dependencies only with `ni`. `pnpm-lock.yaml` is the only lockfile. Never
  run `bun install`, `npm install`, or `yarn`, never commit a second lockfile, and do not edit
  `pnpm-lock.yaml` by hand. Direct `pnpm install --frozen-lockfile` is reserved for the documented
  CI/frozen-install verification. Do not add `packageManager` or `devEngines.packageManager`;
  `mise.toml` and the explicit GitHub Actions setup own tool versions.
- UI strings, code, comments, docs, PR content, and commit messages use English. GitHub issue
  titles, bodies, and comments use Simplified Chinese; keep their code, identifiers, paths, and
  commands in English. Contributor issue tracking lives in GitHub issues (`gh issue`); do not file
  repository work in Linear.
- Prefer JSDoc for non-obvious lifecycle or security behavior, and document why a workaround
  exists.
- Coding agents reproduce the dominant precedent they see in neighboring code, so exemplar hygiene
  is a maintenance duty. When a shared implementation replaces local copies, migrate every call
  site in the same change. Never leave two coexisting ways of doing the same thing.
- Reproduce a reported bug before changing code. Demonstrate the failure against the current build
  so the fix targets the verified cause rather than the first plausible suspect.
- Controlled provider or PTY debugging may deliberately launch one explicitly selected real Agent
  CLI only through the `debug` skill's fail-closed procedure. This does not authorize ordinary E2E,
  CI, or Acceptance to discover or invoke a host provider.
- New behavior ships with a test at the narrowest owning surface. Do not unit-test `.tsx`
  components. Native macOS dialogs are stubbed unless the user's current request explicitly asks
  to verify that dialog.
- Never import Node.js, Electron, or native APIs in Renderer code. Never bypass the structured IPC
  request contract with arbitrary shell commands. Use structured argv arrays for Git and PTY
  launches; never concatenate an untrusted command string.

## Dev instances

- Start the Electron app in the current worktree with
  `bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts dev`. `bun run dev` is the
  first-clone equivalent in this checkout; agent sessions and parallel worktrees must use the
  wrapper so profiles and leases stay isolated. Manage isolated worktrees with `switch-worktree`.
- Stop every dev instance you started before reporting a request complete, and verify it actually
  died. Never `pkill -f "Electron.app/Contents/MacOS/Electron"`: it misses the `Caxri Dev` window
  process, the launcher can outlive the signal, and a sibling worktree or `/Applications/Caxri.app`
  must never be hit. Confirm with `ps` plus a CDP probe, then kill surviving PIDs that match this
  worktree's absolute `apps/server/dist/server/` path. Procedure: `debug`.
- A user-visible Renderer/UI change is not done until it has been verified visually in the running
  dev app over CDP. Passing unit or e2e gates alone does not count. Procedure: `debug`.
- Before using a live instance to verify or disprove a Server change, confirm Server Core and
  Extension Host process start times postdate the change. Procedure: `debug`.

## Product invariants

- Validate filesystem entry paths against the selected Session's authorized Project root. In the
  file explorer and editor, trust symlinks reached through that root, including targets outside it;
  opening, expanding, and editing them must not require another Project or a confirmation prompt.
  Keep the workspace entry path as the user's document identity and preserve the link when saving.
  This does not authorize arbitrary outside paths that were not reached through a workspace link.
  Git may access another linked repository only when its root is covered by an explicitly added Project.
- A Project owns one local root. Sessions reference the Project by ID and cannot submit a root
  path.
- Project and Session deletion remove metadata only. They must never remove the Project folder or
  user files.
- Diagnostic logs, artifacts, and reports must exclude source contents, Terminal output and
  snapshots, Agent transcripts, credentials, environment values, and secret-like settings.
- Logs must do two jobs: explain a specific failure after it happened, and measure behavior well
  enough to reveal a problem nobody reported yet. An outcome recorded without its cause, or
  deduplicated until its real volume is unknowable, does neither. Give such an event a closed reason
  enum, a per-lifetime aggregate, or a duration — and record a state transition when it happens, not
  only the state itself.
- Until Caxri has a public release, optimize for the current architecture instead of preserving
  compatibility with previous local builds. Do not add protocol adapters, legacy Host controls,
  dual-read/write paths, or migration UI only to keep an unpublished build running. Fail clearly
  and direct the operator to a documented reset or reinstall workflow.
- Database schema migrations remain allowed during active development so the current working data
  can evolve safely and upgrade behavior stays exercised. Do not treat schema migrations as a
  reason to preserve unrelated runtime, Host protocol, CLI, or UI compatibility layers.
- Before the public compatibility commitment, the owner may declare an explicit clean-install
  cutoff. Never infer this cutoff or delete local data without explicit user authorization.
- After a public release, backward compatibility becomes a product contract. Removing migrations
  or compatibility paths then requires an explicit release policy, a supported upgrade path, and
  validation against already released versions.

## Skill routing

| Work                                                      | Load                   |
| --------------------------------------------------------- | ---------------------- |
| Substantial new product feature; competing approaches     | `competitors`          |
| Process, IPC, package, persistence, or toolchain contract | `project-architecture` |
| File placement, naming, splits, test location             | `source-layout`        |
| React composition, hooks, shared helpers                  | `react`                |
| Renderer styling tokens                                   | `DESIGN.md`            |
| React render-count audit over CDP with react-scan         | `react-rerender-audit` |
| Focused lint / type / test / knip; formatting             | `quality-check`        |
| Vitest unit/integration regressions                       | `unit-testing`         |
| Playwright Electron workflows                             | `e2e-testing`          |
| Live inspection, CDP, stopping owned processes            | `debug`                |
| Isolated worktrees and desktop lease                      | `switch-worktree`      |
| GitHub issues                                             | `file-issue`           |
| Commits                                                   | `commit`               |
| Pull requests and CI watch                                | `pull-request`         |
| Packaging, GitHub Release, local uninstall                | `$release`             |

# Caxri contributor guide

Caxri is an open-source project. Its code, documentation, GitHub collaboration surfaces, Actions
output, and Releases are public by default. Its current license is source-available rather than
OSI-approved, so keep that legal distinction explicit in licensing claims.

This file is the always-on standing orders. Task procedures, architecture contracts, and toolchain
recipes live in `.agents/skills/`: load the owning skill instead of restating it here.

## Repository layout

| Path          | Purpose                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `apps/`       | Independently runnable Desktop, Server, CLI, and Mobile workspaces                              |
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
  decisions, and operator knowledge. Deliver a core module or large feature with the applicable
  long-term documentation and links from existing discovery entry points in the same change.
  Do not defer necessary documentation to a post-delivery permission question. If an authorized
  delivery omitted it, complete it as follow-up work; ask only when a real product decision or
  material scope expansion needs the user's direction.
- [GLOSSARY.md](GLOSSARY.md) is the product glossary; use its terms and avoid its `_Avoid_` aliases.
  [docs/README.md](docs/README.md) indexes every doc by kind. Doc kinds, frontmatter, and
  retirement follow `write-docs`.
- Use `.agents/skills/` for agent-discoverable, task-routed execution workflows and the architecture
  or toolchain contracts an agent must load to work safely. Keep reusable automation beside its
  owning skill. Keep each skill description specific enough for reliable routing.
- Contributor skill invocation follows [.agents/invocation.md](.agents/invocation.md).
- When a difficult, ambiguous, or costly decision would benefit from an independent perspective,
  use `dianjiang` to consult another agent harness. Keep the consultation read-only unless the
  current request explicitly authorizes the same scoped mutation. Treat the result as evidence.
  Final adjudication stays with the primary agent against current repository state.
- Judge routine product choices yourself by practicality and extensibility. Caxri's security bar is
  a single user on their own machine, not a multi-tenant threat model; do not hold back a useful
  feature over theoretical risk. Escalate only schema design, a large feature needing design,
  destructive or credential steps, genuinely ambiguous requirements, and steps needing the user's
  hands.
- Treat concrete UI improvement feedback with a clear, bounded outcome as an implementation
  request. Proceed through delivery unless the user explicitly asks for discussion or analysis only.
- For requests that exclude new UI, classify each acceptance criterion separately. New behavior
  alone does not imply new UI: keyboard handling in an existing input or sorting by the latest
  message can remain in scope. Exclude only the criterion that requires new UI elements or needs an
  unresolved product decision, and report unfinished or unverified criteria explicitly. Existing
  implementation explains current behavior; it does not prove that it satisfies the request.
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
- Before modifying code, reuse the existing worktree and branch for the current delivery. Treat
  follow-up reports and corrections in the same conversation as one delivery batch by default;
  keep their commits, pull request, and CI on that existing branch. A new delivery that starts from
  the primary checkout creates its own worktree through `switch-worktree` directly; that is the
  expected first step, not a decision to confirm. Only a session that already owns a task worktree
  needs authority for a second checkout: the user asks for it explicitly, or confirms through the
  question tool after the agent explains why the current worktree cannot own the change. Do not
  modify code directly on `main` or an unrelated task's branch unless the user explicitly requests
  it.
- Before the owner declares the first public compatibility release, the maintainer wants proactive
  delivery from coding agents: an implementation or bug-fix request that lands in a task worktree
  delegates the whole
  loop (commit, push, PR, CI repair, merge, issue closeout, primary-checkout sync) as defined in
  `switch-worktree`'s default delivery flow. Do not stop at a green local check to ask whether to
  open or merge the PR; only an explicit analysis-only, local-only, or no-merge instruction narrows
  that scope.
- Keep one open pull request and one current CI run for a delivery batch. Add later fixes to the
  existing branch and update its pull request instead of opening sibling pull requests. Split only
  across different repositories or release boundaries, when the existing branch cannot safely own
  the change, or when the user explicitly requests it; otherwise ask before splitting. Cancel an
  obsolete run before pushing a replacement so exact-head evidence and hosted CI spend stay
  attributable to the current batch.
- `main` requires the `guards` status check to pass before anything merges, with no bypass for any
  actor, so a raw `git push` to `main` always fails: GitHub rejects it outright because the pushed
  commit has never had `guards` run against its exact SHA. Every change, including a one-line
  documentation fix or a small fix the user explicitly authorized to skip review, goes through a
  pull request. Documentation-only diffs carry standing merge authorization: open a pull request
  (no separate worktree needed) and merge it once `guards` passes. Which diffs may merge without
  waiting for the non-required `checks`/`e2e` job is defined only in `pull-request`'s fast-merge
  section. `main` and remote branches can move at any moment.
- When you encounter commits you did not author (after a branch switch, fetch, rebase, or a PR
  merge), treat the newest commits as authoritative by default. Rebase or merge onto them and
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
- Treat backticks and `$()` in shell command strings as executable syntax. Put literal search
  patterns containing them in single quotes or pass them as structured arguments; never interpolate
  them through a double-quoted command string.
- UI strings, code, comments, docs, PR content, and commit messages use English. GitHub issue
  titles, bodies, and comments use Simplified Chinese; keep their code, identifiers, paths, and
  commands in English. Contributor issue tracking lives in GitHub issues (`gh issue`); do not file
  repository work in Linear.
- Caxri is an open-source project, so write every tracked file, commit message, issue, and CI
  artifact for a public audience. Never commit a private
  organization, repository, ticket identifier, tracker URL, internal hostname, internal file path,
  real person, home path carrying a real account name, or credential: not in a fixture, not in a
  comment, not in Chinese. Reference an upstream only after verifying it resolves without
  authentication. History cannot be cleaned retroactively once published, so prevention is the only
  lever. Apply `oss-confidentiality` to content and `open-source-readiness` to publication mechanics.
- Never write an em-dash (U+2014) in contributor prose: docs, skills, and code comments. Use a
  colon, semicolon, comma, period, or parentheses instead. Product copy (UI strings, Agent prompts)
  is out of scope; do not rewrite its punctuation as a side effect of a style rule. `bun run
em-dash-check` enforces this in the `guards` job and the pre-commit hook.
- When delivered work adopts an idea, interaction, value, or format from an external project,
  record it in `.agents/skills/competitors/references/feature-references.md` in the same change
  (procedure: `competitors`); copied code, assets, or text also needs a `THIRD_PARTY_NOTICES.md`
  entry. For example, a shortcut chosen because Orca uses it gets a row under Orca.
- Prefer JSDoc for non-obvious lifecycle or security behavior, and document why a workaround
  exists.
- Coding agents reproduce the dominant precedent they see in neighboring code, so exemplar hygiene
  is a maintenance duty. When a shared implementation replaces local copies, migrate every call
  site in the same change. Never leave two coexisting ways of doing the same thing.
- Reproduce a reported bug before changing code. Demonstrate the failure against the current build
  so the fix targets the verified cause rather than the first plausible suspect.
- Never use `git stash` to set work aside temporarily, for example to compare a test before and after a
  fix. Every worktree and sibling session shares one stash stack. A `push` that saves nothing (an
  untracked path, no changes) leaves someone else's entry on top, and the following `pop` applies
  that entry to your checkout. Copy the file aside and restore it instead.
- After a patch adds new files alongside edits, verify each new path exists before treating the patch
  as complete; a reported patch success does not prove every added file was written.
- If a tool temporarily shows an existing worktree as sparse or missing, verify it from a persistent shell
  against its absolute path and Git worktree metadata, then back up the diff before any repair. Do not recreate,
  remove, or reset that worktree based on one tool view.
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
- Stop every dev instance, E2E run, or benchmark you started before reporting a request complete,
  and verify it actually died:
  `bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts stop`. It signals only what
  this checkout owns, resolved from the worktree's absolute path and the launcher's process record.
- Never terminate Caxri, Electron, or Playwright by name or bundle pattern: `pkill -f "Caxri.app"`,
  `pkill -f Electron`, `killall Caxri`, or any variant. Those patterns read as "this checkout" and
  mean "every match on the machine": they hit `/Applications/Caxri.app`, a sibling worktree, and
  unrelated Electron apps, while still missing the `Caxri Dev` window process and the launcher. Kill
  a PID only after resolving it from this worktree's absolute path. Confirm with `ps` plus a CDP
  probe. Procedure: `debug`.
- A user-visible Renderer/UI change is not done until it has been verified visually in the running
  dev app over CDP. Passing unit or e2e gates alone does not count. Procedure: `debug`.
- A user-visible mobile change is not done until its screens were captured on the disposable
  emulator and read as a first-time user would read them, not checked against your own intent. For
  every screenshot check the visible labels and terminology against Desktop's names (never copy an
  internal or conversational word such as "panel" into the UI), duplicate entries to the same data,
  and the offline, empty, and error states. Procedure: `acceptance` (Android surface).
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
  enum, a per-lifetime aggregate, or a duration, and record a state transition when it happens, not
  only the state itself.
- Agent Chat is the primary Agent surface: design new Agent-facing features for Chat first, and a
  feature may ship Chat-only. The PTY Terminal surface is permanent; Chat work must not remove,
  hide, or regress its launch, input, resume, surface switch, suspension, or restore paths. For
  example, a Chat-only Fork action is fine, but a shared Agent menu change that breaks
  `claude --resume` in a PTY is a bug. See [ADR 0015](docs/adr/0015-chat-primary-agent-surface.md).
- Until the owner declares Caxri's first compatibility release, optimize for the current architecture
  instead of preserving compatibility with previous local builds. Do not add protocol adapters,
  legacy Host controls, dual-read/write paths, or migration UI only to keep an unpublished build
  running. Fail clearly and direct the operator to a documented reset or reinstall workflow.
- Database schema migrations remain allowed during active development so the current working data
  can evolve safely and upgrade behavior stays exercised. Do not treat schema migrations as a
  reason to preserve unrelated runtime, Host protocol, CLI, or UI compatibility layers.
- Before the public compatibility commitment, the owner may declare an explicit clean-install
  cutoff. Never infer this cutoff or delete local data without explicit user authorization.
- After the owner explicitly declares a compatibility release, backward compatibility becomes a
  product contract. Removing migrations or compatibility paths then requires an explicit release
  policy, a supported upgrade path, and validation against already released versions.
- Repository visibility is not a release. The source being publicly readable does not trigger any
  rule above that depends on a compatibility release, does not create existing users to support,
  and does not change the iteration strategy. The compatibility contract starts at the first
  release the owner explicitly declares as its baseline, not at the moment the repository becomes
  readable or a development artifact is published. Never add a compatibility layer, migration UI,
  deprecation path, or contributor-facing process because the repository is public.

## Skill routing

| Work                                                      | Load                    |
| --------------------------------------------------------- | ----------------------- |
| Substantial new product feature; competing approaches     | `competitors`           |
| Process, IPC, package, persistence, or toolchain contract | `project-architecture`  |
| File placement, naming, splits, test location             | `source-layout`         |
| Adding/editing a doc, ADR, or retiring a plan/spike       | `write-docs`            |
| React composition, hooks, shared helpers                  | `react`                 |
| Renderer visual and interaction design                    | `DESIGN.md`             |
| React render-count audit over CDP with react-scan         | `react-rerender-audit`  |
| Focused lint / type / test / knip; formatting             | `quality-check`         |
| Vitest unit/integration regressions                       | `unit-testing`          |
| Playwright Electron workflows                             | `e2e-testing`           |
| Terminal interaction reports, CDP, owned process stop     | `debug`                 |
| Public-content confidentiality review                     | `oss-confidentiality`   |
| Publication, history, Actions, and Release exposure audit | `open-source-readiness` |
| Isolated worktrees and desktop lease                      | `switch-worktree`       |
| GitHub issues                                             | `file-issue`            |
| Commits                                                   | `commit`                |
| Pull requests and CI watch                                | `pull-request`          |
| Packaging, GitHub Release, local uninstall                | `$release`              |

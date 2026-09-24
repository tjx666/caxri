---
name: quality-check
description: Run Caxri's compact changed-file validation entry point. Use after editing code or documentation, before committing, when choosing focused lint, Vitest, type, or Playwright E2E checks, when running format/lint/typecheck/test repository-wide, or when interpreting `bun run check` output.
---

# Quality Check

Use the repository-owned checker instead of loading every validation command into context:

```bash
bun run --silent check [files...] [--lint] [--test] [--type] [--knip] [--e2e] [--e2e-grep '<pattern>'] [--staged]
```

## Selection

- For scripted rewrites, assert the expected match count before writing and inspect the diff before
  claiming coverage; a successful script exit does not prove the intended change occurred.
- Iterate with the narrowest owning test, then run one changed-file check after the cohesive source
  batch is complete. Re-run only gates invalidated by later edits.
- With no selector, run lint and related tests.
- With no file arguments, inspect committed changes since the `origin/main` merge base plus staged,
  unstaged, and untracked files. `--staged` narrows this to the index.
- Explicit files take priority over Git discovery.
- `--lint` applies ESLint, oxlint type-aware (`.oxlintrc.json`, TS files only), and Prettier fixes
  to supported files. Always inspect the resulting diff. Appending file paths to `bun run format`
  does not narrow formatting; use `bun run --silent check <files...> --lint` for a focused pass.
- `--test` runs changed test files, the existing bounded colocated/domain candidates, and Vitest
  suites that statically import a changed source through a relative path, tsconfig alias, or
  workspace package export. Discovery crosses at most two pure re-export barrels, including
  package entrypoints, but does not follow ordinary imports.
  Keep the checker's source roots aligned with Vitest's include patterns, including `extensions/`.
  It deliberately ignores dynamic and transitive imports so composition-root suites do not turn a
  focused check into a broad test run. Renderer source changes also run the design and theme
  contracts, which scan that source tree at runtime without importing individual files.
- `--type` runs the repository-wide TypeScript check because TypeScript cannot safely validate one
  file in isolation.
- `--knip` runs the repository-wide dead-code and unused-export gate for Renderer or shared-contract
  changes.
- `--e2e` requires one or more explicit `e2e/*.e2e.ts` files, rebuilds Caxri, and runs only those
  Playwright specs. It acquires the repository desktop lease before the build and keeps it through
  every spec; a live owner fails fast with its worktree, PID, and lease age. Add `--e2e-wait <seconds>`
  for a bounded atomic retry (1–300 seconds), otherwise contention fails immediately. It never
  infers E2E specs from Git changes or launches the full suite. The
  check summary lists related consumer specs for explicit selection. The real-Agent and intentional
  failure-isolation specs retain their dedicated guarded entrypoints.
- `--e2e-grep '<pattern>'` narrows `--e2e` to one Playwright test-title pattern.
- Rebuild before focused Electron E2E whenever relevant `src/` files changed after the previous
  build; the checker's `--e2e` path performs that rebuild automatically.
- Finish `--lint` before starting a build or Electron E2E. Its automatic fixes mutate source;
  running both concurrently invalidates the build-freshness receipt before Electron can launch.

Pass a test path explicitly when a source file has a nonstandard test that does not directly import
the source boundary. The checker never launches full Electron E2E, packaging, or performance gates
automatically. Use explicit `--e2e` files for the smallest Electron workflow, and the owning
task-routed skill for broader authorized gates.

An E2E path passed with `--test` may report zero tests because Vitest does not own Playwright files.
That is selection feedback, not a passing E2E result; use `--e2e` instead. Call the Skill tool with
"unit-testing" for focused Vitest selection and regression design, and Call the Skill tool with
"e2e-testing" for Electron isolation.

Successful output reports dirty ownership layers, suggested follow-up gates, and actually executed
checks as separate fields. Suggested gates are not execution receipts. Failures include the
underlying tool output needed to act.

`bun run knip` remains a repository-wide CI gate; run `knip` (or `--knip`) before pushing Renderer
or shared-contract changes. CI runs `doctor` through `bun run doctor:changed` (scoped to the diff
against `origin/main`, full-repo only on an initial push); `doctor` is slower and normally remains
a CI validator.
For mobile or Renderer React changes, run `bun run doctor:changed` after new files are staged or
committed and before pushing. Its Git diff scope omits untracked files.

## Repository-wide gates

Use these when a focused `check` is the wrong width, not as the default after every edit:

- Format: `bun run format` / `bun run format:check`. Markdown: `bun run format:md` /
  `bun run format:md:check`.
- Full local gates: `bun run lint` (syntactic ESLint), `bun run lint:type-aware` (oxlint/tsgolint
  type-aware rules — see `docs/type-aware-linting.md`), and `bun run typecheck`.
- `bun run test` is **not** one of them. The full unit suite is a remote gate that CI runs on every
  pushed head, so `bun run test` and a bare `vitest run` refuse to start locally. Only the user
  authorizes a local full run, by setting `CAXRI_FULL_SUITE_AUTHORIZED=1`; an agent never sets that
  variable on its own judgement. Use `bun run check <changed files>` or name the test files with
  `rtk vitest run <file>` instead.

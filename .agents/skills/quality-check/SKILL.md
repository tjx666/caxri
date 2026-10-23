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
- With no selector, run lint and related tests, plus the repository-wide typecheck and `knip`
  whenever a changed or deleted path can affect types: a TypeScript source, a `tsconfig*.json`, a
  `package.json`, or `pnpm-lock.yaml`. Lint and tests alone once passed a type error, and an
  export left without an importer, that then failed CI. An explicit selector runs exactly what it
  names.
- With no file arguments, inspect committed changes since the `origin/main` merge base plus staged,
  unstaged, and untracked files, deletions included. A rename counts as its deleted source plus its
  added destination. `--staged` narrows this to the index. Lint and tests see existing files;
  deleted paths decide whether to typecheck and select the path-reference contract below.
- Explicit files take priority over Git discovery.
  Pass individual files, not directories; directory arguments are not expanded into their contents.
  Use `rg --files` to discover the concrete paths before selecting a feature's files.
- `--lint` applies ESLint, oxlint type-aware (`.oxlintrc.json`, TS files only), and Prettier fixes
  to supported files. Always inspect the resulting diff. Appending file paths to `bun run format`
  does not narrow formatting; use `bun run --silent check <files...> --lint` for a focused pass.
  When the changed set includes source files, `--lint` also runs the source-size ratchet; when it
  includes Markdown, `--lint` also runs the documentation check. Neither autofixes -- see
  "Guardrails" below to interpret a failure.
- `--test` runs changed test files, the existing bounded colocated/domain candidates, and Vitest
  suites that statically import a changed source through a relative path, tsconfig alias, or
  workspace package export. Discovery crosses at most two pure re-export barrels, including
  package entrypoints, but does not follow ordinary imports. A queried import (`theme.css?raw`) or
  an `import.meta.glob` pattern selects its test for that exact file, stylesheets included.
  Keep the checker's source roots aligned with Vitest's include patterns, including `extensions/`.
  It deliberately ignores dynamic and transitive imports so composition-root suites do not turn a
  focused check into a broad test run. Renderer source changes also run the design and theme
  contracts and the React Compiler coverage ledger, which scan that source tree at runtime without
  importing individual files. A deleted
  or renamed path, or an edit to `doctor.config.jsonc` or `components.json`, also runs
  `scripts/__tests__/doctor-config-paths.test.ts`, because those configs name source paths as
  plain strings. A changed or removed path inside a directory `scripts/directory-density-baseline.ts`
  guards runs `scripts/__tests__/directory-density-ratchet.test.ts`, which counts files on disk.
- For added or changed production structured-log writes, explicitly include
  `scripts/__tests__/logging-contract.test.ts` in the focused check. It scans call sites rather
  than importing them, so import-based related-test discovery cannot select this contract.
- `--type` runs the repository-wide TypeScript check (about 16 seconds) because TypeScript cannot
  safely validate one file in isolation.
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

`bun run knip` is repository-wide (about 3 s), and CI runs it in the `full` checks scope (a main
push, an explicit dispatch, or a ready PR on a full-validation path) and in the `affected` scope
ordinary ready source PRs get; draft and `focused-*` scopes skip it. The default local selection
already runs it for TypeScript and manifest changes; pass `--knip` when an explicit selector omits
it. CI runs `doctor` through `bun run doctor:changed` (scoped to the diff
against `origin/main`, full-repo only on an initial push); `doctor` is slower and normally remains
a CI validator.
For mobile or Renderer React changes, run `bun run doctor:changed` after new files are staged or
committed and before pushing. Its Git diff scope omits untracked files.

## Repository-wide gates

Use these when a focused `check` is the wrong width, not as the default after every edit:

- Format: `bun run format` / `bun run format:check`. Markdown: `bun run format:md` /
  `bun run format:md:check`.
- Full local gates: `bun run lint` (syntactic ESLint), `bun run lint:type-aware` (oxlint/tsgolint
  type-aware rules, see `docs/type-aware-linting.md`), and `bun run typecheck`.
- `bun run test` is **not** one of them. The full unit suite is a remote gate that CI runs in the
  `full` checks scope (a main push, an explicit dispatch, or a ready PR on a full-validation path);
  a ready PR's `affected` scope runs only `vitest related` on its changed sources. Either way,
  `bun run test` and a bare
  `vitest run` refuse to start locally. Only the user authorizes a local full run, by setting `CAXRI_FULL_SUITE_AUTHORIZED=1`; an agent never sets that
  variable on its own judgement or on another agent's verdict, including while repairing CI. Use
  `bun run check <changed files>` or name the test files with
  `bunx vitest run <file>` instead.

## Guardrails

Three gates run automatically -- inside `check --lint`, in the pre-commit hook, and in CI -- so a
contributor never has to remember to invoke them by hand. Each is also its own `bun run` script for
a standalone or repository-wide run.

- **`bun run gitleaks`** scans for committed secrets with `.gitleaks.toml` (extends gitleaks' default
  ruleset with narrowly path- and regex-scoped allowlists for this repository's known non-secret
  false positives, e.g. keyboard-shortcut strings). The pre-commit hook scans the Git index
  (`--staged`); CI scans the commits a push or pull request actually introduced
  (`GITLEAKS_BASE_REVISION`/`GITLEAKS_HEAD_REVISION`), falling back to the full history when no base
  revision is available (the first push to a branch or `workflow_dispatch`). A
  finding fails closed with `--redact`, so the failure output never leaks the secret itself. To fix:
  rotate and remove a real secret; for a verified false positive, extend `.gitleaks.toml` with a
  narrowly scoped allowlist entry (never a blanket one) and explain why in a comment.
  `scripts/prepare-gitleaks.ts` provisions the pinned binary (checksum-verified download, cached
  under `.cache/tool-cache` locally or `$RUNNER_TOOL_CACHE/caxri` in CI) whenever it is not already
  on `PATH` at the pinned version.
- **`bun run source-size-ratchet`** compares each changed source file's working-tree line count
  against its line count at the merge base with `origin/main` (`--base <ref>` to override). It fails
  whenever a file ends at or above 600 lines and grew: a file already over 600 that grew further, an
  existing file under 600 that your edit pushes to 600 or more, or a new path (including a rename
  target) that lands at or above 600. Git rename detection keeps a pure move from counting as growth.
  `check --lint` runs it when the changed set includes source, and the pre-commit hook runs it when
  the staged set does -- a one-line test fix is exactly the edit that skips `check`. It
  never fails a file that shrank, even while still above 600 lines: it is a growth ratchet, not a
  restatement of ESLint's absolute `max-lines: 800` ceiling. To fix: split the flagged file by
  responsibility into smaller, cohesively-owned files (see the source-layout skill) -- do not
  compress it to fit. This applies to an edit that newly crosses 600: extract a cohesive module in
  the same change so the edited file ends below 600 or no larger than its merge-base size. There is
  no allowlist for hand-written files; `RATCHET_IGNORE_PATH_PREFIXES` exempts only generated or
  vendored paths.
- **`bun run docs-check`** (`scripts/documentation-check.ts`) validates the documentation this
  repository always keeps consistent (frontmatter, cross-references, repository-relative links,
  README index completeness). It always runs unscoped, even from a focused invocation, both because
  it is cheap (well under a second) and because a scoped run would miss an index gap the changed
  Markdown itself did not touch. `check --lint` and the pre-commit hook run it whenever the changed
  or staged set includes a `.md` file.
- **`bun run em-dash-check`** (`scripts/em-dash-check.ts`) fails on any em-dash (U+2014) in
  contributor prose: docs, skills, other non-code text files, and comments in code, outside the
  vendored `licenses/` and `tools/` trees. Rewrite the sentence with a colon, semicolon, comma,
  period, or parentheses. Product copy (string literals and JSX text in code) is out of scope. It
  scans the whole tree in one `git grep`, so `check --lint`, the pre-commit hook, and the `guards`
  job run it unscoped.

All four also sit in the full CI platform-check manifest (`scripts/ci-platform-gates.ts`), so
`bun run scripts/ci-platform-checks.ts` exercises them even outside a diff.

---
name: quality-check
description: Run Caxri's compact changed-file validation entry point. Use after editing code or documentation, before committing, when choosing focused lint, Vitest, type, or Playwright E2E checks, when running format/lint/typecheck/test repository-wide, or when interpreting `bun run check` output.
---

# Quality Check

Use the repository-owned checker instead of loading every validation command into context:

```bash
bun run --silent check [files...] [--lint] [--test] [--type] [--knip] [--related] [--e2e] [--e2e-grep '<pattern>'] [--staged]
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
- Explicit files take priority over Git discovery. Pass one file per argument. A directory, or a
  path that is neither a file nor a deletion Git records, fails with exit 2 before any gate runs;
  a deleted path stays valid because it selects the tests that still reference it. Use
  `rg --files` to discover the concrete paths before selecting a feature's files.
- `--lint` applies ESLint, oxlint type-aware (`.oxlintrc.json`, TS files only), and `bun fmt` fixes
  to supported files, formatting before ESLint so `caxri/jsdoc-format` wraps comments at their final indentation. Always inspect the resulting diff. The summary names every input whose bytes the fixes changed as `autofixed <paths>`; commit or
  discard those before pushing, since a green summary otherwise hides a fix that never reached the commit. Appending file paths to `bun run format`
  does not narrow formatting; use `bun run --silent check <files...> --lint` for a focused pass.
  When the changed set includes source files, `--lint` also runs the source-size ratchet; when it
  includes Markdown or a removed or renamed path, `--lint` also runs the documentation check. Neither autofixes -- see
  "Guardrails" below to interpret a failure. When the diff adds or removes a file, `--lint` also
  lints, without the ESLint cache, the untouched TypeScript siblings in that directory (and in its
  parent when the directory is `hooks/`, `__tests__/`, or `utils/`), reported as
  `directory siblings <count>`: `caxri/feature-directory-structure` judges a file by the folders
  beside it, so adding `settings/hooks/` once failed two untouched siblings only in hosted lint.
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
  plain strings. A root or workspace `package.json` also runs the manifest-reading contracts
  (`toolchain-contract`, `workspace-package-contract`, `workspace-contract`, and for root manifests
  `workspace-dependency-contract`), which assert scripts and ranges without importing source. The
  root `package.json` also runs the contracts that read its `build` and Knip settings
  (`eslint-toolchain-contract`, `oxlint-toolchain-contract`, `extension-test-packaging`).
  A changed `Dockerfile` runs `toolchain-contract`, which rejects a copy of a `mise.toml` version.
  A changed or removed path inside a directory `scripts/directory-density-baseline.ts`
  guards runs `scripts/__tests__/directory-density-ratchet.test.ts`, which counts files on disk.
  A changed or removed `packages/protocol/src/` source runs the tests that enumerate every registry
  method (`control-server-lane`, `operation-dispatcher`, `domain-service`, `role-capabilities`,
  and the Caxri Bot and Benchmark window policies), which reach method specs only through the
  aggregated registry.
  A changed or removed top-level `e2e/*.e2e.ts` spec runs `scripts/__tests__/e2e-pools.test.ts`,
  which reads every spec's launch options to check its pool classification.
  A locale catalog, Desktop-shared i18n copy, or protocol Agent Chat label file runs the three
  Renderer i18n contracts (`i18n`, `zh-cn-terminology`, `english-counterpart-parity`), which reach
  those sources only through the aggregated locale resources. Any changed or removed executable
  source (the scope `scripts/reporters/ci-e2e-log-safety-scope.ts` defines) runs
  `scripts/__tests__/ci-e2e-log-safety.test.ts`, which scans every launcher for Playwright configs
  and reporters.
- For added or changed production structured-log writes, explicitly include
  `scripts/__tests__/logging-contract.test.ts` in the focused check. It scans call sites rather
  than importing them, so import-based related-test discovery cannot select this contract.
- `--type` runs the repository-wide TypeScript check (`bun check` per project, about 4 seconds)
  because TypeScript cannot safely validate one file in isolation. `bun check` keeps no incremental
  state, so every run is a full check.
- `--knip` runs the repository-wide dead-code and unused-export gate for Renderer or shared-contract
  changes.
- `--related` runs `vitest related` over the changed sources with the hosted `affected` scope's
  argv, so it also reaches the transitive importers `--test` deliberately skips. It is the
  pre-fast-merge gate `pull-request` requires; never hand-compose `vitest related` instead.
- `--e2e` requires one or more explicit `e2e/*.e2e.ts` files, rebuilds Caxri, and runs only those
  Playwright specs. It acquires the repository desktop lease before the build and keeps it through
  every spec; a live owner fails fast with its worktree, PID, and lease age, and the error names
  `--e2e-wait`. Add `--e2e-wait <seconds>` for a bounded atomic retry (1–1800 seconds), otherwise
  contention fails immediately; use it instead of a hand-written retry loop, and run a long wait in
  the background. It never infers E2E specs from Git changes or launches the full suite. The
  check summary lists related consumer specs for explicit selection, and warns (never fails) with
  `spec:line` when an E2E spec still asserts English locale copy that the change edited or removed.
  The real-Agent and intentional failure-isolation specs retain their dedicated guarded entrypoints.
- `--e2e-grep '<pattern>'` narrows `--e2e` to one Playwright test-title pattern.
- The checker's `--e2e` path rebuilds only when the build receipt (`scripts/build-receipt.ts`) no
  longer matches the current inputs and outputs, and reports `build reused` otherwise. Edits under
  `e2e/`, `docs/`, `.agents/`, and `.github/` never force a rebuild; a build of another flavor (for
  example `CAXRI_REACT_PROFILING=1`) does. Direct Playwright and Acceptance launches accept any
  flavor of current sources. When the installed `node_modules` differs from `pnpm-lock.yaml`, no
  build can record a receipt, so `--e2e` and every launch fail at once with a `run "ni"` message
  instead of rebuilding; run `ni` and retry.
- Finish `--lint` before starting a build or Electron E2E. Its automatic fixes mutate source;
  running both concurrently invalidates the build-freshness receipt before Electron can launch.
  The same holds for the whole `--e2e` run, background runs included: an edit, a `git commit`
  (its hook rewrites staged files), or a rebase in that worktree fails every later spec with
  `Build output is stale`. Wait for the run to finish; read-only work can continue meanwhile.

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
  (`--staged`); every push or pull-request CI route scans only the commits it introduced
  (`GITLEAKS_BASE_REVISION`/`GITLEAKS_HEAD_REVISION`), and a manual CI dispatch scans its ref's
  commits beyond `origin/main`. A bare local invocation without a base revision remains an
  intentional full-history audit; it reports historical identifying values `.gitleaks.toml`
  documents as unrewritten, so it is an audit, not a gate. A
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
  the staged set does -- a one-line test fix is exactly the edit that skips `check`. The hook passes
  `--staged`, which measures the index instead of the working tree and ignores untracked files, so
  committing one slice of a larger split is judged on that slice alone. It
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
  or staged set includes a `.md` file or a deleted or renamed path (a code-only rename can break a
  document's citation).
- **`bun run em-dash-check`** (`scripts/em-dash-check.ts`) fails on any em-dash (U+2014) in
  contributor prose: docs, skills, other non-code text files, and comments in code, outside the
  vendored `licenses/` and `tools/` trees. Rewrite the sentence with a colon, semicolon, comma,
  period, or parentheses. Product copy (string literals and JSX text in code) is out of scope. It
  scans the whole tree in one `git grep`, so `check --lint`, the pre-commit hook, and the `guards`
  job run it unscoped; the hook passes `--staged` to read the index instead of the working tree.

The pre-commit hook additionally runs two `guards` tests when the staged set can affect them, so a
violation fails locally instead of in CI: `scripts/__tests__/directory-density-ratchet.test.ts` when
the index adds, deletes, or renames a file, and `scripts/__tests__/react-compiler-coverage.test.ts`
when a staged Renderer `.ts`/`.tsx` file or `scripts/react-compiler-*.ts` changed.

All four also sit in the full CI platform-check manifest (`scripts/ci-platform-gates.ts`), so
`bun run scripts/ci-platform-checks.ts` exercises them even outside a diff.

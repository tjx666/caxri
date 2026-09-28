---
kind: historical
status: historical
---

# Oxlint spike (issue #177 stage 6)

> **Outcome (2026-08): partially adopted.** The "defer" recommendation below applied to a
> wholesale ESLint replacement. The repository has since adopted the narrower split this spike's
> §6 sketched: oxlint owns the type-aware layer, `node/no-sync`, and a small reviewed set of
> vendored anti-slop policies; ESLint keeps the remaining syntactic rules. `.oxlintrc.json` is now
> a production gate wired into
> `bun run lint:type-aware`, `bun run check`, lint-staged, and CI. See
> `docs/type-aware-linting.md` for the current contract; this file remains the historical evidence
> record, and the config snippets below describe the spike-era `.oxlintrc.json`, not the current
> one.

Evidence-only spike. Oxlint is **not** wired into `bun run check`, lint-staged, or CI by this
change. `.oxlintrc.json` and `spike:oxlint`/`spike:oxlint:type-aware` exist only so this record is
reproducible; the recommendation below is advisory, per issue #177's decision gate.

- Exact HEAD this spike ran against: `d3ab3c58e52c2884bd78135840de3851aecc5216`
- `oxlint`: `1.78.0` (`oxlint --version`)
- `oxlint-tsgolint`: `7.0.2001` (required separately for `--type-aware`; `oxlint` prints
  `Failed to find tsgolint executable` without it)
- Machine: Apple M5 Max, 18 logical CPUs, 128 GB RAM (`sysctl -n machdep.cpu.brand_string`)
- Repository size at HEAD: 794 tracked `.ts`/`.tsx`/`.js`/`.mts`/`.cts` files under
  `src`, `packages/protocol/src`, `apps/cli/src`, `e2e`, `scripts`, `.agents`
- Commands used throughout: `bun run spike:oxlint` (`oxlint -c .oxlintrc.json .`) and
  `bun run spike:oxlint:type-aware` (`oxlint -c .oxlintrc.json --type-aware .`)

## 1. Setup

`ni -D oxlint oxlint-tsgolint` (latest, resolved to the versions above). Both landed in the pnpm
catalog (`pnpm-workspace.yaml`) the same way the repository's other shared tool versions do;
`scripts/__tests__/workspace-contract.test.ts`'s pinned catalog assertion was updated to include
them, per this task's authorization to update pinned expectations tripped by additive spike
dependencies.

`.oxlintrc.json` enables the plugins with the closest match to the repository's current ESLint
composition (`typescript`, `unicorn`, `oxc`, `import`, `jsdoc`, `promise`, `node`), sets
`correctness`/`suspicious` to `error` and `perf` to `warn` (oxlint's default posture), and mirrors
the `eslint.config.ts` `globalIgnores` list. It explicitly re-adds the few rules that need
non-default options to match the current repo config (`unicorn/filename-case: kebabCase`,
`typescript/no-misused-promises` with `checksVoidReturn: false`, `max-lines: 800`,
`react/rules-of-hooks`, and the `no-restricted-imports` `exec`/`execSync` and Renderer
Node/Electron/native-module bans, scoped via `overrides` the same way `eslint.config.ts` scopes
them). `node/no-sync` is likewise moved into a directory-scoped `overrides` block (Main, Runtime,
`shared/node`, CLI, `scripts/`, `.agents/**/scripts`, excluding tests) instead of the global
`categories`, because oxlint's categories apply repo-wide and would otherwise flag legitimate sync
calls (e.g. in `e2e/`) that the repository's own `n/no-sync` scoping never covered.

## 2. `--type-aware` and the tsconfig compatibility concern

The task called out a suspected `tsconfig.json` `baseUrl` incompatibility. That specific
hypothesis did not reproduce: removing `compilerOptions.paths`/adding an explicit `baseUrl` in a
spike-local tsconfig copy made no difference. Two separate, real compatibility issues were found
instead:

1. **Wrong-case file paths panic `tsgolint` instead of failing gracefully.** On macOS's
   case-insensitive default filesystem, `oxlint --type-aware apps/desktop/src/renderer/src/App.tsx`
   (a stale pre-migration casing of the on-disk `app.tsx`) opens the file but then panics inside
   `tsgolint` with `panic: Expected file '.../App.tsx' to be in program '.../tsconfig.web.json'`,
   because the program-membership check compares path strings exactly. Invoking with the correct
   casing (`apps/desktop/src/renderer/src/app.tsx`) works in both plain and `--type-aware` modes
   and reports a genuine
   type-aware diagnostic (`typescript/consistent-return`), and full-repo runs include the file
   normally — verified by re-running both invocations at this HEAD. This is an oxlint/tsgolint
   robustness bug only for wrong-case explicit paths (editor integrations passing stale paths),
   not a coverage gap on this repository.

The panic is a minor single-file/editor-integration concern and was reproducible with or without
path aliases, so it is
unrelated to `baseUrl`.

With `oxlint-tsgolint` installed, `oxlint --type-aware .` (no explicit `--tsconfig`) completes
without panicking and produces diagnostics (see §5 for the volume, which is large and dominated by
rules the repository's `typeCheckedConfig` does not enable — see §6).

## 3. Fixture parity

Run against each fixture in `scripts/fixtures/eslint/` directly (bypassing `.oxlintrc.json`'s
`scripts/fixtures/eslint/**` ignore, matching how
`scripts/__tests__/eslint-toolchain-contract.test.ts` lints them with `ignore: false`):

| Fixture                                                                                    | ESLint rule (contract test)                    | Oxlint result                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type-aware-violation.ts` (floating promise)                                               | `@typescript-eslint/no-floating-promises`      | **Caught** — `typescript/no-floating-promises` (needs `--type-aware`)                                                                                                           |
| `type-aware-violation.ts` (unsafe `as any`)                                                | `@typescript-eslint/no-unsafe-assignment`      | **Caught by a different rule** — `typescript/no-unsafe-type-assertion` (needs `--type-aware`); `typescript/no-unsafe-assignment` exists in oxlint but did not fire on this line |
| `NotKebabCaseFixture.ts`                                                                   | `unicorn/filename-case`                        | **Caught** — `unicorn/filename-case` (same rule family)                                                                                                                         |
| `child-process-exec-fixture.ts`                                                            | `no-restricted-imports`                        | **Caught** — `no-restricted-imports` (same rule, same config shape)                                                                                                             |
| `spawn-shell-true-fixture.ts`                                                              | `no-restricted-syntax` (custom AST selector)   | **Not caught** — oxlint has no equivalent AST-selector rule                                                                                                                     |
| `bad-mapped-component-fixture.tsx`                                                         | `caxri/filename-export-mapping` (local plugin) | **Not caught** — oxlint does not support local/custom rule plugins                                                                                                              |
| `use-bad-mapped-hook-fixture.ts`                                                           | `caxri/filename-export-mapping` (local plugin) | **Not caught** — same reason                                                                                                                                                    |
| `good-mapped-component-fixture.tsx`, `use-good-mapped-hook-fixture.ts` (positive fixtures) | — (expected silent)                            | **Silent**, as expected — no false positive                                                                                                                                     |

Summary: 4 of 6 negative fixtures caught (2 by an exact-equivalent rule, 1 by a different but
overlapping rule, 1 by the identical rule), 2 of 6 not caught (both require capabilities oxlint's
architecture does not have: custom AST-selector rules and local rule plugins).

## 4. Coverage diff on the clean tree

`bun run spike:oxlint` (no `--type-aware`) against the full repo with `.oxlintrc.json`: **141 new
diagnostics**, all in categories the repository's actual effective ESLint config (verified via
`eslint --print-config` on representative Main/Runtime/CLI, Renderer, and `e2e/` files) does
**not** enable at all: `no-shadow` (46), `oxc/no-map-spread` (23, `warn`), `unicorn/consistent
-function-scoping` (22), `no-underscore-dangle` (16), `promise/always-return` (7),
`import/no-unassigned-import` (5), `import/no-named-as-default` (5), `import/default` (5),
`unicorn/prefer-string-starts-ends-with` (2), `promise/no-multiple-resolved` (2),
`no-unmodified-loop-condition` (2), `oxc/no-accumulating-spread` (1, `warn`),
`unicorn/require-post-message-target-origin` (1). These come from oxlint's default
`correctness`/`suspicious` categories being broader than this repository's curated shared preset,
not from a config mistake in `.oxlintrc.json` — reaching true zero-noise parity would mean
disabling each of these individually to match the shared `@yutengjing/eslint-config-typescript`
preset's actual rule set.

Three more diagnostics fire on rules the repo genuinely shares with oxlint, but are false
positives specific to oxlint's rule implementation (not fixed, per this spike's scope):

- `unicorn/require-module-specifiers` flags `export {};` in `apps/desktop/src/renderer/src/env.d.ts` (the
  idiomatic way to force a `.d.ts` file into module scope for `declare global`).
- `no-unsafe-optional-chaining` flags a fully-optional-chained property access chain
  (`config.rules?.['no-restricted-imports']?.[0]`) in
  `scripts/__tests__/eslint-toolchain-contract.test.ts:54` that ESLint's own implementation of the
  same rule does not flag.
- `no-new` flags `new TerminalCommandTracker(...)` used purely for its constructor side effect in
  `terminal-command-tracker.test.ts:138` — a legitimate pattern; core ESLint's `no-new` is not part of
  this repository's rule set at all, so this is only visible because of oxlint's broader default
  category, not a shared-rule regression.

`oxlint --type-aware .` on the clean tree adds far more: **679 diagnostics**, dominated by
`typescript/no-unsafe-type-assertion` (478) and `typescript/consistent-return` (50) — rules
`--type-aware` enables by default that are well outside the specific `recommendedTypeChecked`
subset `typeCheckedConfig` actually turns on in `eslint.config.ts`. Matching the current type-aware
posture would require per-rule tuning beyond this spike's scope.

### Rule-family coverage summary

| ESLint layer                                                                      | Oxlint coverage                                                                                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescriptConfig` (basic + import-x + TS recommended, syntactic)                 | Close match via `typescript`/`import`/`unicorn` plugins; rule names and option shapes mostly align                                          |
| `typeCheckedConfig` (`recommendedTypeChecked`, `projectService: true`)            | Partial via `--type-aware`; default bundle is far broader (needs per-rule tuning) and panics on wrong-case explicit paths (see §2)          |
| `markdownProcessorConfig` (fenced JS/TS in `.md`)                                 | **Not covered** — oxlint has no Markdown processor                                                                                          |
| `eslint-plugin-react-hooks` v7 `recommended-latest` (incl. React Compiler checks) | Only `react/rules-of-hooks` exists; no `exhaustive-deps`, `purity`, `set-state-in-render`, or other React-Compiler-backed rules             |
| `eslint-plugin-react-refresh`                                                     | **Not covered**                                                                                                                             |
| `caxri/filename-export-mapping` (local plugin)                                    | **Not covered** — no local/custom plugin support (confirmed in §3)                                                                          |
| `no-restricted-syntax` (shell:true ban, default-export ban)                       | **Not covered** — no custom AST-selector rule (confirmed in §3)                                                                             |
| `no-restricted-imports` (exec/execSync ban, Renderer boundary)                    | **Exact match** (confirmed in §3)                                                                                                           |
| `unicorn/filename-case`                                                           | **Exact match** (confirmed in §3), modulo the case-fold bug in §2                                                                           |
| `n/no-sync`                                                                       | **Exact match** (`node/no-sync`), needs manual directory scoping via `overrides` (categories are global)                                    |
| `simple-import-sort`, `unused-imports`                                            | **Partial** — oxlint has `sort-imports` (different grouping) and only core `no-unused-vars`, no autofix-focused unused-imports rule         |
| `eslint-plugin-regexp`                                                            | **Partial** — a handful of regexp-related rules exist under `unicorn`/core, not a dedicated plugin with matching depth                      |
| `import-x` boundary/circular-dependency semantics                                 | **Unverified/likely partial** — oxlint's `import` plugin needs its own resolver config for this repo's aliases; not exercised in this spike |

## 5. Performance

3 warm samples each (`/usr/bin/time -p`, `real` seconds), median reported. Cold = first
invocation of the session for that tool (oxlint has no persistent on-disk cache to clear); ESLint
cold = `rm -rf .cache/eslint` then run.

| Command                                   | Cold   | Warm samples          | Warm median |
| ----------------------------------------- | ------ | --------------------- | ----------- |
| `oxlint -c .oxlintrc.json .`              | 0.18s  | 0.17s / 0.17s / 0.17s | 0.17s       |
| `oxlint -c .oxlintrc.json --type-aware .` | 1.76s  | 1.78s / 1.76s / 1.99s | 1.78s       |
| `bun run lint` (ESLint, `--cache`)        | 49.05s | 1.67s / 1.65s / 1.65s | 1.65s       |

ESLint's warm numbers reflect its content-hash `--cache` (`.cache/eslint/.eslintcache`) mostly
no-op'ing on an unchanged tree, not a comparable "full analysis, warm process" number — oxlint has
no such cache and does a full scan on every invocation. The fair like-for-like comparison is the
**cold** numbers: oxlint is ~270x faster than ESLint cold, and `oxlint --type-aware` is ~28x
faster than ESLint cold. Against ESLint's cached warm path (the actual day-to-day/lint-staged
experience today), plain oxlint is still ~10x faster and `--type-aware` oxlint is roughly on par
(slightly slower, 1.78s vs 1.65s), while catching far fewer of the currently-enabled rule families
(§4).

## 6. Recommendation

**Defer.** Do not introduce `eslint-plugin-oxlint` yet. Coverage is not equivalent: two
repository-defining pieces (the local `caxri/filename-export-mapping` plugin and the
`no-restricted-syntax` shell/default-export bans) have no oxlint equivalent at all, `--type-aware`
either needs substantial per-rule tuning to avoid a large volume of currently-un-enabled
diagnostics or ships an under-tuned bundle, and `tsgolint` panics on wrong-case explicit file
paths instead of failing gracefully (§2). The measured performance benefit is real and large
against a cold ESLint run, but modest-to-roughly-even against ESLint's already-cached warm path,
which is what `bun run check`/lint-staged/CI actually exercise after the first invocation.
Revisit after oxlint narrows its local-rule/AST-selector gap and hardens the wrong-case-path
handling; at that point a narrower
`eslint-plugin-oxlint` adoption (disabling only the exact-equivalent rule families identified in
§4 — `unicorn/filename-case`, `no-restricted-imports`, `n/no-sync` — while keeping ESLint for
everything else) would be the lowest-risk next step, not a wholesale switch.

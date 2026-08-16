# Type-aware linting split: ESLint (syntactic) + oxlint/tsgolint (typed)

Since 2026-08, the JS/TS lint gate is split by capability instead of running one tool for
everything:

- **ESLint** (`bun run lint`, `eslint.config.ts`) runs every syntactic rule: the shared
  `@yutengjing/eslint-config-typescript` preset (minus its `typeCheckedConfig` layer), import
  boundaries, `no-restricted-syntax`/`no-restricted-imports` bans, and the local
  `caxri/filename-export-mapping` plugin. It deliberately does **not** enable `projectService`, so
  it never builds a TypeScript program.
- **oxlint + tsgolint** (`bun run lint:type-aware`, `.oxlintrc.json`) runs every rule that needs
  type information, plus `node/no-sync` (whose `eslint-plugin-n` v18 implementation demands typed
  linting and therefore could not stay on the ESLint side).

## Why

The evidence spike (`docs/oxlint-spike.md`, issue #177 stage 6) measured ESLint's cold full-repo
run at ~49 s, dominated by `projectService` type checking; `oxlint --type-aware` covers the same
type-aware rule families in under 2 s cold. The spike's "defer" recommendation applied to a
wholesale ESLint replacement — this split instead moves only the layer oxlint covers completely,
keeping ESLint for the local-plugin and AST-selector capabilities oxlint lacks.

## Enabled type-aware rules

`.oxlintrc.json` keeps all default oxlint categories off (so it never overlaps ESLint's syntactic
territory) and enables, as errors:

- The exact type-aware subset the repository previously received through
  `typeCheckedConfig`/`recommendedTypeChecked` (`no-floating-promises`,
  `no-misused-promises` with `checksVoidReturn: false`, the `no-unsafe-*` family, `await-thenable`,
  `require-await`, `restrict-plus-operands`, `restrict-template-expressions`, `unbound-method`,
  etc. — see the config for the full list).
- High-consensus community additions researched from typescript-eslint maintainers and published
  configs: `no-deprecated`, `no-unnecessary-condition` (`allowConstantLoopConditions: true`),
  `prefer-nullish-coalescing`, `prefer-optional-chain`, `return-await` (`in-try-catch`), and
  `switch-exhaustiveness-check` (`considerDefaultExhaustiveForUnions: true`).
  `strict-boolean-expressions` is deliberately excluded as noisy/stylistic per the
  typescript-eslint maintainers' own assessment (typescript-eslint#2345).

## Where it runs

- `bun run lint:type-aware` — repository-wide gate; CI runs it in the full-checks job right after
  ESLint.
- `bun run check --lint` — the focused changed-file pipeline runs
  `oxlint --type-aware --fix` on changed TS files between `eslint --fix` and Prettier (also the CI
  focused-scope path).
- lint-staged — the `*.{ts,tsx,mts,cts}` chain runs the same autofix on staged files.

## Suppressions

ESLint knows nothing about these rules, so `eslint-disable` comments will not work (and would fail
the gate as unused directives). Use oxlint's own directive with a justification:

```ts
// oxlint-disable-next-line typescript/no-unnecessary-condition -- defensive: IPC payload may predate the schema
// oxlint-disable-next-line node/no-sync -- deliberate startup boundary before the async runtime exists
```

## Contract tests

`scripts/__tests__/oxlint-toolchain-contract.test.ts` asserts the split holds: the type-aware
fixture trips `typescript/no-floating-promises` under oxlint, `no-sync-fixture.ts` trips
`node/no-sync`, and `.oxlintrc.json` keeps default categories off.
`scripts/__tests__/eslint-toolchain-contract.test.ts` asserts the inverse: ESLint stays silent on
the type-aware fixture and configures no type-aware rules.

## Known limitations

- tsgolint panics on wrong-case explicit file paths on macOS's case-insensitive filesystem
  (spike §2); paths from git/lint-staged are always correct-case, so this only affects hand-typed
  invocations.
- oxlint resolves `overrides[].files` globs relative to the config file's directory —
  `.oxlintrc.json` must stay at the repository root.
- oxlint has no Markdown processor, so fenced code blocks in `*.md` get syntactic ESLint coverage
  only.

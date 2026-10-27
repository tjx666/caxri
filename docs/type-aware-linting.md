---
kind: living
status: current
---

# Linting split: ESLint (syntactic) + oxlint/tsgolint (typed and anti-slop)

Since 2026-08, the JS/TS lint gate is split by capability instead of running one tool for
everything:

- **ESLint** (`bun run lint`, `eslint.config.ts`) runs every syntactic rule: the shared
  `@yutengjing/eslint-config-typescript` preset (minus its `typeCheckedConfig` layer), import
  boundaries, `no-restricted-syntax`/`no-restricted-imports` bans, and the local
  `caxri/filename-export-mapping` plugin. It deliberately does **not** enable `projectService`, so
  it never builds a TypeScript program.
- **oxlint + tsgolint** (`bun run lint:type-aware`, `.oxlintrc.json`) runs every rule that needs
  type information, plus `node/no-sync` (whose `eslint-plugin-n` v18 implementation demands typed
  linting and therefore could not stay on the ESLint side) and a deliberately small set of
  vendored anti-slop rules.

## Why

The evidence spike (`docs/oxlint-spike.md`, issue #177 stage 6) measured ESLint's cold full-repo
run at ~49 s, dominated by `projectService` type checking; `oxlint --type-aware` covers the same
type-aware rule families in under 2 s cold. The spike's "defer" recommendation applied to a
wholesale ESLint replacement; this split instead moves only the layer oxlint covers completely,
keeping ESLint for the local-plugin and AST-selector capabilities oxlint lacks.

## Vendored anti-slop policy

The generic plugin under `tools/oxlint/anti-slop/` comes from
[`dmmulroy/anti-slop@6d538555`](https://github.com/dmmulroy/anti-slop/commit/6d538555cb151d4121ed51a27db81890eacf8ae9).
Upstream explicitly recommends vendoring and adapting the rules instead of treating them as a fixed
package. Caxri therefore pins `oxlint` and `@oxlint/plugins` to the same installed version and keeps
the plugin out of product runtime and package outputs.

The initial audit ran all 15 generic rules against the full repository. Stock severity produced
3,030 diagnostics across 590 files, including 1,247 in tests and fixtures. Several high-volume rules
also report the boundary parsers, type predicates, generic constraints, Zod `.shape` reads, and
test fixtures they claim should replace the flagged pattern. This matches the public
[568k-line adoption report](https://github.com/dmmulroy/anti-slop/issues/21) and its upstream
correctness reports for [type predicates](https://github.com/dmmulroy/anti-slop/issues/15),
[external member names](https://github.com/dmmulroy/anti-slop/issues/16),
[generic constraints](https://github.com/dmmulroy/anti-slop/issues/17),
[closed-key records](https://github.com/dmmulroy/anti-slop/issues/18), and
[`typeof` existence probes](https://github.com/dmmulroy/anti-slop/issues/19).

Five precise, zero- or low-migration rules block the gate:

- `no-conditional-empty-object-spread`
- `no-object-parameters`
- `no-reflect-apply`
- `no-unknown-type-aliases`
- `no-widen-then-assert`

The other ten remain explicitly `off`, not hidden behind file baselines or blanket suppressions:

| Rule                                        | Initial findings | Reason to defer                                                                                                    |
| ------------------------------------------- | ---------------: | ------------------------------------------------------------------------------------------------------------------ |
| `require-safety-comment-for-type-assertion` |            1,292 | Would add mostly ceremonial comments to existing assertions and double-reports chained assertions.                 |
| `no-unknown-parameters`                     |              395 | Rejects correct parsers, type predicates, and safe `catch` annotations.                                            |
| `no-runtime-typeof`                         |              386 | Rejects hand-written boundary decoders, built-in unions, and existence probes.                                     |
| `no-known-value-widening`                   |              266 | Reports closed-key `Record` contracts and intentional public return types.                                         |
| `no-chained-type-assertions`                |              183 | High-signal production rule, but most findings are deliberate unit/E2E fixture casts; it needs a scoped migration. |
| `no-unsafe-dictionary-type`                 |              172 | Rejects generic constraints that cannot name a concrete value contract.                                            |
| `no-unknown-returns`                        |              137 | Requires separate ownership decisions for extension and transport boundaries.                                      |
| `no-shape-in-symbol-names`                  |               86 | Reports external APIs such as Zod `.shape` and ordinary geometric terminology.                                     |
| `no-module-mocking`                         |               57 | A blanket ban conflicts with existing test policy and requires an explicit test-architecture decision.             |
| `no-reflect-get`                            |               49 | Existing sites intentionally inspect dynamic errors and test seams; shared parsing policy comes first.             |

Disabled rules become blocking only after a focused audit proves that their signal fits Caxri and
the corresponding cleanup is complete. This keeps the main gate green without pretending a
directory or file exemption is enforcement.

## Enabled type-aware rules

`.oxlintrc.json` keeps all default oxlint categories off (so it never overlaps ESLint's syntactic
territory) and enables, as errors:

- The exact type-aware subset the repository previously received through
  `typeCheckedConfig`/`recommendedTypeChecked` (`no-floating-promises`,
  `no-misused-promises` with `checksVoidReturn: false`, the `no-unsafe-*` family, `await-thenable`,
  `require-await`, `restrict-plus-operands`, `restrict-template-expressions`, `unbound-method`,
  etc.; see the config for the full list).
- High-consensus community additions researched from typescript-eslint maintainers and published
  configs: `no-deprecated`, `no-unnecessary-condition` (`allowConstantLoopConditions: true`),
  `prefer-nullish-coalescing`, `prefer-optional-chain`, `return-await` (`in-try-catch`), and
  `switch-exhaustiveness-check` (`considerDefaultExhaustiveForUnions: true`).
  `strict-boolean-expressions` is deliberately excluded as noisy/stylistic per the
  typescript-eslint maintainers' own assessment (typescript-eslint#2345).

## Where it runs

- `bun run lint:type-aware`: repository-wide gate; CI runs it in the full-checks job right after
  ESLint.
- `bun run check --lint`: the focused changed-file pipeline runs
  `oxlint --type-aware --fix` on changed TS files between `eslint --fix` and the final `bun fmt` pass (also the CI
  focused-scope path).
- lint-staged: the `*.{ts,tsx,mts,cts}` chain runs the same autofix on staged files.

## Suppressions

ESLint knows nothing about these rules, so `eslint-disable` comments will not work (and would fail
the gate as unused directives). Use oxlint's own directive with a justification:

```ts
// oxlint-disable-next-line typescript/no-unnecessary-condition -- defensive: IPC payload may predate the schema
// oxlint-disable-next-line node/no-sync -- deliberate startup boundary before the async runtime exists
```

## Contract tests

`scripts/__tests__/oxlint-toolchain-contract.test.ts` asserts the split holds: the type-aware
fixture trips `typescript/no-floating-promises`, `no-sync-fixture.ts` trips `node/no-sync`, the
anti-slop fixture trips all five active rules, and the exact active/deferred rule sets
cannot change silently. `.oxlintrc.json` keeps default categories off.
`scripts/__tests__/eslint-toolchain-contract.test.ts` asserts the inverse: ESLint stays silent on
the type-aware fixture and configures no type-aware rules.

## Known limitations

- tsgolint panics on wrong-case explicit file paths on macOS's case-insensitive filesystem
  (spike §2); paths from git/lint-staged are always correct-case, so this only affects hand-typed
  invocations.
- oxlint resolves `overrides[].files` globs relative to the config file's directory:
  `.oxlintrc.json` must stay at the repository root.
- oxlint has no Markdown processor, so fenced code blocks in `*.md` get syntactic ESLint coverage
  only.
- JavaScript plugins receive Oxlint's syntax tree, not TypeScript type information. A vendored rule
  must not be promoted merely because its diagnostic text sounds type-aware.

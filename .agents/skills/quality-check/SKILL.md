---
name: quality-check
description: Run Caxri's compact changed-file validation entry point. Use after editing code or documentation, before committing, when choosing focused lint, Vitest, type, or Playwright E2E checks, or when interpreting `bun run check` output.
---

# Quality Check

Use the repository-owned checker instead of loading every validation command into context:

```bash
bun run --silent check [files...] [--lint] [--test] [--type] [--knip] [--e2e] [--e2e-grep '<pattern>'] [--staged]
```

## Selection

- With no selector, run lint and related tests.
- With no file arguments, inspect staged, unstaged, and untracked files. `--staged` narrows this to the index.
- Explicit files take priority over Git discovery.
- `--lint` applies ESLint and Prettier fixes to supported files. Always inspect the resulting diff.
- `--test` runs changed test files and colocated tests named `foo.test.*` or `__tests__/foo.test.*`.
- `--type` runs the repository-wide TypeScript check because TypeScript cannot safely validate one file in isolation.
- `--knip` runs the repository-wide dead-code and unused-export gate for Renderer or shared-contract changes.
- `--e2e` requires one or more explicit `e2e/*.e2e.ts` files, rebuilds Caxri, and runs only those
  Playwright specs. It never infers E2E specs from Git changes or launches the full suite. The
  real-Agent and intentional failure-isolation specs retain their dedicated guarded entrypoints.
- `--e2e-grep '<pattern>'` narrows `--e2e` to one Playwright test-title pattern.

Pass a test path explicitly when a source file has a nonstandard integration test. The checker
never launches full Electron E2E, packaging, or performance gates automatically. Use explicit
`--e2e` files for the smallest Electron workflow and the dedicated commands in `AGENTS.md` for
broader authorized gates.

An E2E path passed with `--test` may report zero tests because Vitest does not own Playwright files.
That is selection feedback, not a passing E2E result; use `--e2e` instead. Use `unit-test` for
focused Vitest selection and regression design, and follow `e2e-testing` for Electron isolation.

Successful ESLint, Prettier, build, Vitest, and Playwright output is intentionally collapsed into
one summary. Failures include the underlying tool output needed to act.

---
name: quality-check
description: Run Caxri's compact changed-file validation entry point. Use after editing code or documentation, before committing, when choosing focused lint, test, or type checks, or when interpreting `bun run check` output.
---

# Quality Check

Use the repository-owned checker instead of loading every validation command into context:

```bash
bun run check [files...] [--lint] [--test] [--type] [--knip] [--staged]
```

## Selection

- With no selector, run lint and related tests.
- With no file arguments, inspect staged, unstaged, and untracked files. `--staged` narrows this to the index.
- Explicit files take priority over Git discovery.
- `--lint` applies ESLint and Prettier fixes to supported files. Always inspect the resulting diff.
- `--test` runs changed test files and colocated tests named `foo.test.*` or `__tests__/foo.test.*`.
- `--type` runs the repository-wide TypeScript check because TypeScript cannot safely validate one file in isolation.
- `--knip` runs the repository-wide dead-code and unused-export gate for Renderer or shared-contract changes.

Pass a test path explicitly when a source file has a nonstandard integration test. The checker never launches full Electron E2E, packaging, or performance gates automatically; use the focused commands in `AGENTS.md` when the change crosses those boundaries.

An E2E path passed with `--test` may report zero tests because Vitest does not own Playwright files.
That is selection feedback, not a passing E2E result; route the focused Playwright command through
the `e2e-testing` skill. Use `unit-test` for focused Vitest selection and regression design.

Successful output is intentionally compact. Failures include the underlying tool output needed to act.

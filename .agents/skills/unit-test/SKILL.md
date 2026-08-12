---
name: unit-test
description: Validate Caxri logic with focused Vitest unit and integration coverage. Use after changing pure logic, Runtime or shared services, persistence, security, configuration, or repository skill scripts; when reproducing a bug below the Electron desktop boundary; or when selecting the narrowest behavior-level regression before a changed-file check. Do not use for Playwright Electron workflows or full E2E delivery.
---

# Unit Test

Validate the smallest observable behavior below the Electron desktop boundary.

1. Put tests with their source domain. Renderer logic stays beside its source; Main, Runtime, shared,
   and skill code use their domain-local `__tests__/` or `scripts/*.test.ts` convention.
2. For a reproducible bug, add a behavior-level regression that fails for the bug before the fix.
   Prefer observable output and integration boundaries over internal call assertions.
3. Do not unit-test React components by default. Extract meaningful state into a hook or pure
   function; route rendering and interaction to `e2e-testing`.
4. Run the narrowest relevant files:

   ```bash
   bunx vitest run --silent='passed-only' <test-file...>
   ```

5. Finish a source batch with `quality-check`:

   ```bash
   bun run check <changed-files...> --lint --test [--type] [--knip]
   ```

6. Keep fixtures content-free. Never copy real tokens, user code, Terminal output, Agent
   transcripts, production paths, or credentials into tests or artifacts.
7. Run the full `bun run test` suite only for release/CI parity, when explicitly requested, or when
   a shared cross-cutting contract makes focused coverage insufficient.

This skill does not own Playwright, Electron desktop lifecycle, real PTYs, window focus, hosted full
E2E, or the guarded Go fallback. Invoke `e2e-testing` for those surfaces.

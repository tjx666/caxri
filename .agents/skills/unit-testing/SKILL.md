---
name: unit-testing
description: Validate Caxri logic with focused Vitest unit and integration coverage. Use after changing pure logic, Runtime or shared services, persistence, security, configuration, or repository skill scripts; when reproducing a bug below the Electron desktop boundary; or when selecting the narrowest behavior-level regression before a changed-file check. Do not use for Playwright Electron workflows or full E2E delivery.
---

# Unit Testing

Validate the smallest observable behavior below the Electron desktop boundary.

1. Put tests with their source domain. Renderer logic stays beside its source; Main, Runtime, CLI,
   shared, and skill code use their domain-local `__tests__/` or `scripts/*.test.ts` convention.
   Placement details live in `source-layout`.
2. New features ship with a behavior-level test for the functionality they add. For a
   reproducible bug, add a regression that fails for the bug before the fix, in the same commit.
   Prefer observable output and integration boundaries over internal call assertions. When the
   fix sits above a testable boundary, extract the logic so the failure mode is testable rather
   than skipping the test. Existing untested modules are debt, not precedent: touching an
   untested area does not require backfilling its whole suite, but the behavior you add or change
   there must be covered.
   Callback regressions must assert the callback was actually registered before invoking it;
   a no-op fallback can make an unreachable scenario falsely pass.
   For chunked or asynchronously parsed streams, preserve the original chunk boundaries and
   exercise the real encoder/parser when its buffering affects the result. Joining chunks before
   the assertion or checking enqueue alone cannot prove correct consumer output or reset ordering.
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
7. Leave the full `bun run test` suite to CI; it refuses to run locally unless the user sets
   `CAXRI_FULL_SUITE_AUTHORIZED=1` (see `quality-check`).

This skill does not own Playwright, Electron desktop lifecycle, real PTYs, window focus, remote
full E2E, or the guarded Go fallback. Call the Skill tool with "e2e-testing" for those surfaces.

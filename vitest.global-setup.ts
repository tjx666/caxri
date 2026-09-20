import { assertFullSuiteAuthorized } from './.agents/skills/quality-check/scripts/full-suite-authorization.ts';

/**
 * Vitest `globalSetup`. Runs once in the CLI's own process, so `process.argv` is the real invocation and a bare `vitest
 * run` is refused the same way `bun run test` is.
 */
export default function setup(): void {
    assertFullSuiteAuthorized('unit');
}

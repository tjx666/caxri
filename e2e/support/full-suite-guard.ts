import { assertFullSuiteAuthorized } from '../../.agents/skills/quality-check/scripts/full-suite-authorization.ts';

/**
 * Playwright `globalSetup`. Runs once in the CLI's own process, so `process.argv` is the real invocation and a bare
 * `playwright test` is refused the same way `bun run test:e2e` is.
 */
export default function globalSetup(): void {
    assertFullSuiteAuthorized('e2e');
}

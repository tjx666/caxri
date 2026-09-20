import process from 'node:process';

import type { FullSuiteRunner } from './full-suite-authorization.ts';
import { fullSuiteRefusalMessage, isFullSuiteAuthorized } from './full-suite-authorization.ts';

/**
 * Package-script entrypoint for the full-suite guard.
 *
 * The runners enforce the same rule from their `globalSetup`, but `test:e2e` spends a full desktop build before
 * Playwright ever loads. Refusing here keeps that wasted build from happening at all. Invoked with the runner name, so
 * it never has to guess which gate the script is about to start.
 */
const runner = process.argv[2] as FullSuiteRunner | undefined;
if (runner !== 'unit' && runner !== 'e2e') {
    process.stderr.write('Usage: assert-full-suite-authorized.ts <unit|e2e>\n');
    process.exit(2);
}

if (!isFullSuiteAuthorized()) {
    process.stderr.write(`${fullSuiteRefusalMessage(runner)}\n`);
    process.exit(1);
}

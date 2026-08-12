import { expect, test as base } from '@playwright/test';

import { runWithE2EErrorGate } from './error-gate.ts';

export { allowE2EErrors } from './error-gate.ts';

interface E2EFixtures {
    e2eErrorGate: void;
}

export const test = base.extend<E2EFixtures>({
    e2eErrorGate: [
        async ({ browserName }, use, testInfo) => {
            void browserName;
            await runWithE2EErrorGate(testInfo, use);
        },
        { auto: true },
    ],
});

/** Unguarded only so `error-gate.e2e.ts` can assert the shared gate's own teardown failures. */
export const errorGateSelfTest = base;

export { expect };
export type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test';

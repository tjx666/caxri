import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';

import { expect, test as base } from '@playwright/test';

import { runWithE2EErrorGate } from './error-gate.ts';
import { e2eWorkerTemporaryDirectory, resolveE2EWorkerIsolation } from './worker-isolation.ts';

export { allowE2EErrors } from './error-gate.ts';

interface E2EFixtures {
    e2eErrorGate: void;
}

interface E2EWorkerFixtures {
    e2eWorkerIsolation: void;
}

export const test = base.extend<E2EFixtures, E2EWorkerFixtures>({
    e2eErrorGate: [
        // eslint-disable-next-line no-empty-pattern -- Playwright requires the first fixture argument to be an object destructuring pattern
        async ({}, use, testInfo) => {
            await runWithE2EErrorGate(testInfo, use);
        },
        { auto: true },
    ],
    e2eWorkerIsolation: [
        // eslint-disable-next-line no-empty-pattern -- Playwright requires the first fixture argument to be an object destructuring pattern
        async ({}, runWorker) => {
            const original = {
                TEMP: process.env.TEMP,
                TMP: process.env.TMP,
                TMPDIR: process.env.TMPDIR,
            };
            const workerDirectory = e2eWorkerTemporaryDirectory(
                tmpdir(),
                resolveE2EWorkerIsolation(process.env),
            );
            if (workerDirectory) {
                await mkdir(workerDirectory, { recursive: true });
                process.env.TEMP = workerDirectory;
                process.env.TMP = workerDirectory;
                process.env.TMPDIR = workerDirectory;
            }
            let failure: unknown;
            try {
                await runWorker();
            } catch (error: unknown) {
                failure = error;
            }
            try {
                for (const [key, value] of Object.entries(original)) {
                    if (value === undefined) delete process.env[key];
                    else process.env[key] = value;
                }
                if (workerDirectory) {
                    await rm(workerDirectory, { recursive: true, force: true });
                }
            } catch (error) {
                failure ??= error;
            }
            if (failure) {
                throw failure instanceof Error
                    ? failure
                    : new Error('E2E worker fixture failed with a non-Error value');
            }
        },
        { auto: true, scope: 'worker' },
    ],
});

/**
 * Unguarded only so `error-gate.e2e.ts` can assert the shared gate's own teardown failures.
 */
export const errorGateSelfTest = base;

export { expect };
export type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test';

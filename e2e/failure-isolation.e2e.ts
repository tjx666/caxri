import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri } from './support/helpers.ts';

const isEnabled = process.env.CAXRI_E2E_FAILURE_ISOLATION === '1';

test.skip(!isEnabled, 'Run only through scripts/run-e2e-failure-isolation.ts');

test('controlled worker interruption preserves the original failure', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-failure-isolation-original-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });

    /**
     * Playwright stops this worker after the assertion, exercising fixture-driven Electron and namespaced lease
     * teardown before scheduling the replacement test in a fresh worker.
     */
    try {
        expect(running.app.process().pid).toBeLessThan(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the worker interruption already produced the assertion result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('replacement worker reacquires the desktop after controlled interruption', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-failure-isolation-replacement-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await expect(running.page.locator('[data-workbench-welcome]')).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertion above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

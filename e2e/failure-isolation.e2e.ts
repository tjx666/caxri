import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './fixtures.ts';

import { launchCaxri } from './helpers.ts';

const enabled = process.env.CAXRI_E2E_FAILURE_ISOLATION === '1';

test.skip(!enabled, 'Run only through scripts/run-e2e-failure-isolation.ts');

test('controlled worker interruption preserves the original failure', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-failure-isolation-original-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });

    /** Playwright stops this worker after the assertion, exercising fixture-driven Electron and
     * namespaced lease teardown before scheduling the replacement test in a fresh worker. */
    try {
        expect(running.app.process().pid).toBeLessThan(0);
    } finally {
        await running.app.close().catch(() => undefined);
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
        await expect(
            running.page.getByRole('heading', { name: 'Project-first development.' }),
        ).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

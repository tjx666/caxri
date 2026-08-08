import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchCaxri } from './helpers.ts';

test('Check for Updates opens the packaged-only update workflow', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-updates-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette.getByPlaceholder('Search projects, sessions, and commands…').fill('updates');
        await palette.getByText('Check for Updates', { exact: true }).click();

        const dialog = running.page.getByRole('dialog');
        await expect(dialog.getByRole('heading', { name: 'Software Update' })).toBeVisible();
        await expect(dialog).toHaveAttribute('data-update-status', 'unavailable');
        await expect(dialog).toContainText('available in packaged Caxri builds');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

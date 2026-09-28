import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri } from './support/helpers.ts';

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
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * The Acceptance update fixture (#1010) is the only way an unpackaged build can show update UI. This drives the real
 * Main wiring end to end: the launch check publishes the fixed release, the Renderer announces it, and a later manual
 * check re-reads the served state instead of consuming the fixture again.
 */
test('an admitted Acceptance update fixture announces its fixed release off the network', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-updates-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: {
            CAXRI_ACCEPTANCE: '1',
            CAXRI_ACCEPTANCE_UPDATE: 'available:e2e-update-notification',
        },
    });
    try {
        await expect(
            running.page
                .locator('[data-sonner-toast]')
                .filter({ hasText: 'Caxri 999.0.0 is available.' }),
        ).toBeVisible();

        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette.getByPlaceholder('Search projects, sessions, and commands…').fill('updates');
        await palette.getByText('Check for Updates', { exact: true }).click();

        const dialog = running.page.getByRole('dialog');
        await expect(dialog).toHaveAttribute('data-update-status', 'available');
        await expect(dialog).toContainText('Caxri 999.0.0 is available');
        expect(await readFile(join(userData, 'acceptance-update-receipt.jsonl'), 'utf8')).toBe(
            `${JSON.stringify({ caseId: 'e2e-update-notification', fixture: 'available', version: '999.0.0' })}\n`,
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

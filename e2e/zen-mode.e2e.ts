import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

test('Zen Mode hides the chrome around the Terminal and a surface toggle leaves it', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-zen-mode-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const { page } = running;
        const primarySidebar = page.locator('.session-primary-sidebar');
        const secondarySidebarTabs = page.getByRole('tablist', { name: 'Secondary Side Bar' });
        const statusBar = page.locator('footer.statusbar');
        const panelTabs = page.getByRole('tablist', { name: 'Panel' });
        const terminal = page.locator('.xterm').filter({ visible: true });
        await expect(primarySidebar).toBeVisible();
        await expect(secondarySidebarTabs).toBeVisible();
        await expect(statusBar).toBeVisible();

        await page.keyboard.press('Meta+k');
        await page.keyboard.press('z');
        await expect(primarySidebar).toHaveCount(0);
        await expect(secondarySidebarTabs).toHaveCount(0);
        await expect(statusBar).toHaveCount(0);
        await expect(terminal).toHaveCount(1);

        // Toggling a hidden surface leaves Zen Mode and keeps the stored layout, plus the newly opened Panel.
        await page.keyboard.press('Meta+j');
        await expect(panelTabs).toBeVisible();
        await expect(primarySidebar).toBeVisible();
        await expect(secondarySidebarTabs).toBeVisible();
        await expect(statusBar).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

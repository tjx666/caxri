import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, launchCaxriApp } from './support/helpers.ts';

test('Zen Mode hides the chrome around the Terminal and a surface toggle leaves it', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-zen-mode-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    await writeZenSettings(userData);

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

/**
 * Keeps the E2E window out of native full screen, which would take over the developer's Space; the full screen request
 * is covered by unit tests and a window-state readback during CDP verification.
 */
async function writeZenSettings(userData: string): Promise<void> {
    await mkdir(join(userData, 'config'), { recursive: true });
    await writeFile(
        join(userData, 'config', 'settings.jsonc'),
        `${JSON.stringify({ 'zen.fullScreen': false, 'zen.restore': true }, null, 2)}\n`,
    );
}

test('Zen Mode leaves through the hover exit button and comes back after a restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-zen-mode-restore-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await writeZenSettings(userData);

    const first = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(first.page);
        const statusBar = first.page.locator('footer.statusbar');
        const exitButton = first.page.getByRole('button', { name: 'Exit Zen Mode' });
        await expect(statusBar).toBeVisible();

        await first.page.keyboard.press('Meta+k');
        await first.page.keyboard.press('z');
        await expect(statusBar).toHaveCount(0);
        await expect(exitButton).toHaveCSS('opacity', '0');
        await exitButton.hover();
        await expect(exitButton).toHaveCSS('opacity', '1');
        await exitButton.click();
        await expect(statusBar).toBeVisible();
        await expect(exitButton).toHaveCount(0);

        await first.page.keyboard.press('Meta+k');
        await first.page.keyboard.press('z');
        await expect(statusBar).toHaveCount(0);
    } finally {
        try {
            await first.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
    }

    // `launchCaxri` waits on the status bar's readiness attribute, and a restored Zen Mode has no status bar.
    const second = await launchCaxriApp({ userDataDir: userData, testRootPath: root });
    try {
        await expect(second.page.locator('.session-primary-sidebar')).toHaveCount(0);
        await expect(second.page.locator('footer.statusbar')).toHaveCount(0);
        await second.page.getByRole('button', { name: 'Exit Zen Mode' }).click({ force: true });
        await expect(second.page.locator('footer.statusbar')).toBeVisible();
    } finally {
        try {
            await second.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri } from './support/helpers.ts';

async function runFromPalette(page: Page, query: string, title: string): Promise<void> {
    await page.keyboard.press('Meta+Shift+P');
    const palette = page.getByRole('dialog');
    await palette.getByPlaceholder('Search projects, sessions, and commands…').fill(query);
    await palette.getByText(title, { exact: true }).click();
}

test('Performance Monitor opens in-window, moves to its own window, and times a reload of the Workbench', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-performance-monitor-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
    });
    try {
        await runFromPalette(running.page, 'performance monitor', 'Toggle Performance Monitor');
        const overlay = running.page.locator('[data-performance-overlay]');
        await expect(overlay).toBeVisible();
        await expect(overlay.getByText('GPU raster')).toBeVisible();
        await expect(overlay.locator('[data-performance-fps]')).toHaveText(/^\d+\.\d\s*fps$/);

        // Choosing the Window mode moves the monitor out of the page.
        await overlay.locator('[data-performance-mode="window"]').click();
        await expect(overlay).toHaveCount(0);
        await expect.poll(() => running.app.windows().length).toBe(2);
        const monitor = running.app.windows().find((page) => page !== running.page)!;
        await monitor.waitForLoadState('domcontentloaded');
        await expect(
            monitor.getByText('Performance Monitor', { exact: true }).first(),
        ).toBeVisible();
        await expect(monitor.locator('[data-performance-fps]')).toHaveText(/^\d+\.\d\s*fps$/, {
            timeout: 10_000,
        });

        // Reload the original window from the detached one, then see the timing entry.
        await monitor.locator('[data-performance-reload="reload"]').click();
        const entry = monitor.locator('[data-reload-entry]').first();
        await expect(entry).toHaveAttribute('data-reload-outcome', 'done', { timeout: 30_000 });
        await expect(entry.locator('[data-reload-total]')).toHaveText(
            /^\d+(\.\d)? ms$|^\d+\.\d\d s$/,
        );

        // The detached window can hand the monitor back to the Workbench.
        await monitor.locator('[data-performance-mode="overlay"]').click();
        await expect(running.page.locator('[data-performance-overlay]')).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

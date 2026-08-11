import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from './fixtures.ts';

import { launchCaxri, waitForRuntimeReady } from './helpers.ts';

async function toggleScreencastFromPalette(page: Page): Promise<void> {
    await page.keyboard.press('Meta+Shift+P');
    const palette = page.getByRole('dialog');
    await palette.getByPlaceholder('Search projects, sessions, and commands…').fill('screencast');
    await palette.getByText('Toggle Screencast Mode', { exact: true }).click();
}

test('Screencast Mode shows privacy-safe window input and leaves no state after toggle or reload', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-screencast-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await toggleScreencastFromPalette(running.page);
        const overlay = running.page.locator('[data-screencast-overlay]');
        await expect(overlay).toBeVisible();
        await expect(overlay).toHaveCSS('pointer-events', 'none');

        const workbench = running.page.locator('.workbench');
        const workbenchBounds = await workbench.boundingBox();
        expect(workbenchBounds).not.toBeNull();
        await workbench.click({ position: { x: 180, y: 120 } });
        const clickMarker = running.page.locator('[data-screencast-click]');
        await expect(clickMarker).toBeVisible();
        await expect(clickMarker).toHaveCSS('left', `${workbenchBounds!.x + 180}px`);
        await expect(clickMarker).toHaveCSS('top', `${workbenchBounds!.y + 120}px`);
        await expect(clickMarker).toHaveCount(0, { timeout: 2_000 });

        await running.page.keyboard.press('Meta+K');
        const keyOverlay = running.page.locator('[data-screencast-key]');
        await expect(keyOverlay).toContainText('Clear Terminal');
        await expect(keyOverlay.getByLabel('⌘K')).toBeVisible();
        await expect(keyOverlay).toHaveCount(0, { timeout: 3_000 });

        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        const search = palette.getByPlaceholder('Search projects, sessions, and commands…');
        await expect(keyOverlay).toContainText('Open Command Palette');
        await expect(keyOverlay).toHaveCount(0, { timeout: 3_000 });
        await search.pressSequentially('private text');
        await expect(keyOverlay).toHaveCount(0);
        await search.fill('screencast');
        await palette.getByText('Toggle Screencast Mode', { exact: true }).click();

        await expect(overlay).toHaveCount(0);
        await workbench.click({ position: { x: 260, y: 160 } });
        await expect(running.page.locator('[data-screencast-click]')).toHaveCount(0);

        await toggleScreencastFromPalette(running.page);
        await expect(overlay).toBeVisible();
        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect(running.page.locator('[data-screencast-overlay]')).toHaveCount(0);
        await running.page.locator('.workbench').click({ position: { x: 320, y: 200 } });
        await expect(running.page.locator('[data-screencast-click]')).toHaveCount(0);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

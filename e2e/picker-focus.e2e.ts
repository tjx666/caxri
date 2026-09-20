import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';

test('Picker cancellation restores focus without reopening Session details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-picker-focus-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(directory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        const firstId = await selectedSessionId(page);
        await createAdditionalShellSession(page);
        const secondId = await selectedSessionId(page);
        const palette = page.getByRole('dialog', { name: 'Command Palette' });
        const input = page.locator('.xterm-helper-textarea');
        const details = page.locator('.session-activity-card');

        await page.locator('.project-select').focus();
        await page.keyboard.press('ArrowDown');
        const secondRow = sessionCard(page, secondId);
        await expect(secondRow).toBeFocused();
        await expect(details).toBeVisible();
        await page.keyboard.press('Meta+Shift+P');
        await expect(palette.getByRole('combobox')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(palette).toHaveCount(0);
        await expect(secondRow).toBeFocused();
        await expect(details).toHaveCount(0);

        await input.focus();
        await page.keyboard.press('Meta+Shift+P');
        await expect(palette.getByRole('combobox')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(palette).toHaveCount(0);
        await expect(input).toBeFocused();

        await secondRow.focus();
        await page.keyboard.press('ArrowDown');
        const firstRow = sessionCard(page, firstId);
        await expect(firstRow).toBeFocused();
        await expect(details).toHaveCount(1);
        await expect(details).toBeVisible();
        await page.keyboard.press('Meta+Shift+P');
        await expect(palette.getByRole('combobox')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(palette).toHaveCount(0);
        await expect(firstRow).toBeFocused();
        await expect(secondRow).toHaveClass(/active/);
        await expect(details).toHaveCount(0);
        await page.mouse.move(600, 20);
        await firstRow.hover();
        await expect(details).toBeVisible();
        await page.mouse.move(600, 20);
        await expect(details).toHaveCount(0);

        await page.keyboard.press('Meta+Shift+P');
        // IDs are part of cmdk's unique values; both synthetic Sessions can share a display title.
        await palette.locator(`[cmdk-item][data-value$="${firstId}"]`).click();
        await expect(palette).toHaveCount(0);
        await expect(firstRow).toHaveClass(/active/);
        await expect(input).toBeFocused();
        await expect(details).toHaveCount(0);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('revealing the Primary Side Bar preserves workbench focus without opening Session details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-sidebar-focus-e2e-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(directory, 'user-data'),
        testRootPath: root,
    });
    try {
        const { page } = running;
        await createProjectSession(page);
        const terminalInput = page.locator('.xterm-helper-textarea');
        const details = page.locator('.session-activity-card');

        await terminalInput.focus();
        await page.keyboard.press('Meta+[');
        await expect(page.locator('.session-primary-sidebar')).toHaveCount(0);
        await expect(terminalInput).toBeFocused();

        await page.keyboard.press('Meta+[');
        await expect(page.locator('.session-primary-sidebar')).toBeVisible();
        await expect(terminalInput).toBeFocused();
        await expect(details).toHaveCount(0);

        await page.keyboard.press('Meta+0');
        await expect(
            page.locator('[role="treeitem"][data-session-id][aria-selected="true"]'),
        ).toBeFocused();
        await page.keyboard.press('Meta+[');
        await expect(page.locator('.session-primary-sidebar')).toHaveCount(0);
        await expect(terminalInput).toBeFocused();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

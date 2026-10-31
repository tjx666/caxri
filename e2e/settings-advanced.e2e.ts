import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri } from './support/helpers.ts';
import { openSettingsPage, revealSettingsSection } from './support/settings.ts';

test('Settings lists everyday rows first and keeps advanced rows searchable, resettable, and one switch away', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-settings-advanced-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const settings = await openSettingsPage(running.page, { advanced: false });
        const toggle = settings.getByRole('switch', { name: 'Show advanced settings' });
        const navigation = settings.getByRole('navigation', { name: 'Settings categories' });
        const scrollback = settings.getByRole('spinbutton', { name: 'Scrollback lines' });
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
        await expect(settings.getByRole('combobox', { name: 'Default Agent' })).toBeVisible();
        // Every Security row is advanced, so its table of contents entry would be a dead click.
        await expect(navigation.getByRole('button', { name: 'Security', exact: true })).toHaveCount(
            0,
        );
        await revealSettingsSection(settings, 'Terminal');
        await expect(
            settings.getByRole('spinbutton', { name: 'Terminal Font size' }),
        ).toBeVisible();
        await expect(scrollback).toHaveCount(0);

        // Search still reaches an advanced row, tagged so it does not read as part of the default list.
        await settings.getByLabel('Search settings').fill('scrollback');
        await expect(scrollback).toBeVisible();
        await expect(settings.getByText('Advanced', { exact: true })).toBeVisible();
        await scrollback.fill('5000');
        const reset = settings.getByRole('button', { name: 'Reset Scrollback lines to default' });
        await scrollback.hover();
        await reset.click();
        await expect(scrollback).toHaveValue('8000');
        await settings.getByRole('button', { name: 'Clear settings search' }).click();
        await expect(scrollback).toHaveCount(0);

        // The switch is keyboard operable and brings every advanced row and section back.
        await toggle.focus();
        await running.page.keyboard.press('Space');
        await expect(toggle).toHaveAttribute('aria-checked', 'true');
        await expect(
            navigation.getByRole('button', { name: 'Security', exact: true }),
        ).toBeVisible();
        await revealSettingsSection(settings, 'Terminal');
        await expect(scrollback).toBeVisible();
        await expect(settings.getByText('Advanced', { exact: true })).toHaveCount(0);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

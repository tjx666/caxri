import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ThemeTokens } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openSettingsTab, pageRequest } from './support/helpers.ts';

test('Theme presets apply, persist, and detach after a color edit', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-theme-presets-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        let settingsTab = await openSettingsTab(running.page);
        await settingsTab.getByRole('tab', { name: 'Theme', exact: true }).click();
        const preset = settingsTab.getByRole('combobox', { name: 'Theme preset' });
        await expect(preset).toContainText('Dracula');

        await preset.click();
        await Promise.all(
            [
                'Dracula',
                'Monokai',
                'One Dark Pro',
                'Solarized Dark',
                'Solarized Light',
                'Tokyo Night',
                'Oscura Midnight',
                'VS Code Dark+',
            ].map((name) =>
                expect(running.page.getByRole('option', { name, exact: true })).toBeVisible(),
            ),
        );
        await running.page
            .getByRole('option', { name: 'Solarized Light', exact: true })
            .press('Enter');

        await expect(preset).toContainText('Solarized Light');
        await expect
            .poll(async () => {
                const result = await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get');
                return { id: result.value.id, source: result.value.source };
            })
            .toEqual({ id: 'solarized-light', source: 'builtin' });
        await expect
            .poll(() =>
                running.page.evaluate(() =>
                    getComputedStyle(document.documentElement)
                        .getPropertyValue('--background')
                        .trim(),
                ),
            )
            .toBe('#fdf6e3');

        // Settings is a Workbench tab now, not a modal (issue caxri#1289): force a real
        // close and reopen with `Cmd+W`/`Cmd+,` so the preset read below can only pass off a fresh
        // mount, proving the choice was actually persisted rather than just still sitting in memory.
        await running.page.keyboard.press('Meta+w');
        settingsTab = await openSettingsTab(running.page);
        await settingsTab.getByRole('tab', { name: 'Theme', exact: true }).click();
        const restoredPreset = settingsTab.getByRole('combobox', { name: 'Theme preset' });
        await expect(restoredPreset).toContainText('Solarized Light');

        await settingsTab.getByLabel('colors accent color').fill('#268bd2');
        await expect(restoredPreset).toContainText('Custom: Solarized Light');
        await expect
            .poll(async () => {
                const result = await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get');
                return {
                    accent: result.value.colors.accent,
                    id: result.value.id,
                    source: result.value.source,
                };
            })
            .toEqual({ accent: '#268bd2', id: 'custom-solarized-light', source: 'custom' });

        await restoredPreset.click();
        await expect(running.page.getByRole('option', { selected: true })).toHaveCount(0);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

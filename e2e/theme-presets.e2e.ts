import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ThemeTokens } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, pageRequest } from './support/helpers.ts';
import { openSettingsSection, openSettingsTab } from './support/settings.ts';

test('Theme presets apply, persist, and detach after a color edit', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-theme-presets-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        let settingsTab = await openSettingsTab(running.page);
        await openSettingsSection(settingsTab, 'Theme');
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
                'VS Code Light+',
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
        await openSettingsSection(settingsTab, 'Theme');
        const restoredPreset = settingsTab.getByRole('combobox', { name: 'Theme preset' });
        await expect(restoredPreset).toContainText('Solarized Light');

        await settingsTab.getByLabel('colors accent color').fill('#268bd2');
        await expect(restoredPreset).toContainText('Custom — Solarized Light');
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

test('Follow system appearance switches presets live and stops on an explicit single theme', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-theme-follow-system-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const background = () =>
        running.page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
        );
    try {
        const settingsTab = await openSettingsTab(running.page);
        await openSettingsSection(settingsTab, 'Theme');
        await settingsTab.getByRole('button', { name: 'Follow system appearance' }).click();
        // The Theme tab itself owns the pair: both pickers are here, not behind a pointer to General.
        const lightPicker = settingsTab.getByRole('combobox', { name: 'Light theme' });
        const darkPicker = settingsTab.getByRole('combobox', { name: 'Dark theme' });
        await expect(lightPicker).toContainText('VS Code Light+');
        await expect(darkPicker).toContainText('Dracula');

        // The Server holds one explicit theme; the system appearance is resolved in the Renderer, so a switch must
        // repaint the window without rewriting `theme.json`.
        const savedTheme = await pageRequest<{ source: string }>(running.page, 'theme.get');
        await running.page.emulateMedia({ colorScheme: 'light' });
        await expect.poll(background).toBe('#ffffff');
        await running.page.emulateMedia({ colorScheme: 'dark' });
        await expect.poll(background).toBe('#282a36');
        await running.page.emulateMedia({ colorScheme: 'light' });
        await expect.poll(background).toBe('#ffffff');
        expect((await pageRequest<{ source: string }>(running.page, 'theme.get')).source).toBe(
            savedTheme.source,
        );

        // Picking the dark theme here repaints a dark window at once and leaves the light one alone.
        await running.page.emulateMedia({ colorScheme: 'dark' });
        await expect.poll(background).toBe('#282a36');
        await darkPicker.click();
        await running.page.getByRole('option', { name: 'Monokai', exact: true }).click();
        await expect.poll(background).toBe('#272822');
        await running.page.emulateMedia({ colorScheme: 'light' });
        await expect.poll(background).toBe('#ffffff');

        // Choosing a single theme keeps what is on screen and stops following.
        await settingsTab.getByRole('button', { name: 'Use a single theme' }).click();
        await expect(settingsTab.getByRole('combobox', { name: 'Theme preset' })).toContainText(
            'VS Code Light+',
        );
        await running.page.emulateMedia({ colorScheme: 'dark' });
        await expect.poll(background).toBe('#ffffff');
        await expect
            .poll(async () => {
                const result = await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get');
                return result.value.id;
            })
            .toBe('vscode-light-plus');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

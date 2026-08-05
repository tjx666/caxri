import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { launchCaxri } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('sidebar titlebar keeps the drag region without rendering Caxri branding', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-titlebar-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const titlebar = running.page.locator('.sidebar-title');
        await expect(titlebar).not.toContainText('Caxri');
        await expect(titlebar.getByRole('button', { name: 'Add Project' })).toBeVisible();
        expect(
            await titlebar.evaluate((element) => ({
                appRegion: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                height: element.getBoundingClientRect().height,
            })),
        ).toEqual({ appRegion: 'drag', height: 44 });
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('sidebar omits Settings and Search while shortcuts and app menu keep both commands', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-sidebar-entrypoints-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await expect(running.page.locator('.sidebar-footer')).toHaveCount(0);
        await expect(running.page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
        await expect(running.page.getByRole('button', { name: 'Search' })).toHaveCount(0);

        await running.page.keyboard.press('Meta+,');
        await expect(running.page.getByRole('dialog')).toContainText('Settings');
        await running.page.keyboard.press('Escape');
        await running.page.keyboard.press('Meta+Shift+P');
        await expect(
            running.page.getByPlaceholder('Search projects, sessions, and commands…'),
        ).toBeVisible();
        await running.page.keyboard.press('Escape');

        const menuItems = await running.app.evaluate(({ Menu }) => {
            const menu = Menu.getApplicationMenu();
            return ['command.settings.open', 'command.commandPalette.open'].map((id) => {
                const item = menu?.getMenuItemById(id);
                return item ? { accelerator: item.accelerator, id: item.id } : undefined;
            });
        });
        expect(menuItems).toEqual([
            { accelerator: 'Command+,', id: 'command.settings.open' },
            { accelerator: 'Command+Shift+P', id: 'command.commandPalette.open' },
        ]);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

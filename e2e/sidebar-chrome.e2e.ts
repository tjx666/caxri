import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { createProjectSession, launchCaxri } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('sidebar titlebar aligns the Caxri logo with native traffic lights', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-titlebar-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const titlebar = running.page.locator('.sidebar-title');
        const logo = titlebar.locator('[data-caxri-logo]');
        await expect(logo).toBeVisible();
        await expect(titlebar.getByRole('button', { name: 'Add Project' })).toBeVisible();
        const titlebarMetrics = await titlebar.evaluate((element) => {
            const logoBounds = element.querySelector('[data-caxri-logo]')!.getBoundingClientRect();
            const titlebarBounds = element.getBoundingClientRect();
            return {
                appRegion: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                height: titlebarBounds.height,
                logoCenterY: logoBounds.top + logoBounds.height / 2,
                titlebarCenterY: titlebarBounds.top + titlebarBounds.height / 2,
            };
        });
        expect(titlebarMetrics).toMatchObject({ appRegion: 'drag', height: 44 });
        expect(
            Math.abs(titlebarMetrics.logoCenterY - titlebarMetrics.titlebarCenterY),
        ).toBeLessThanOrEqual(0.5);
        expect(
            await running.app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
            ),
        ).toEqual({ x: 15, y: 15 });
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Project and Files actions reveal on hover or focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-sidebar-affordances-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const caption = running.page.locator('.panel-caption');
        const collapse = caption.getByRole('button', { name: 'Collapse Folders' });
        await expect(caption.locator('span')).toHaveText('project');
        await expect(caption.locator('span')).toHaveAttribute('title', await realpath(root));
        await expect(collapse).toHaveCSS('opacity', '0');
        await caption.hover({ position: { x: 8, y: 8 } });
        await expect(collapse).toHaveCSS('opacity', '1');
        await running.page.mouse.move(500, 300);

        const projectHeading = running.page.locator('.project-heading');
        const newSession = projectHeading.getByRole('button', { name: 'New Session in project' });
        const projectDisclosure = projectHeading.getByRole('button', {
            name: 'Collapse project',
        });
        await expect(projectHeading.locator('.project-disclosure')).toHaveCount(1);
        await expect(projectDisclosure.locator('.project-folder-icon')).toHaveClass(
            /lucide-folder-open/,
        );
        await projectDisclosure.click();
        const collapsedDisclosure = projectHeading.getByRole('button', {
            name: 'Expand project',
        });
        await expect(collapsedDisclosure.locator('.project-folder-icon')).toHaveClass(
            /lucide-folder(?!-open)/,
        );
        await collapsedDisclosure.click();
        const projectName = projectHeading.getByRole('button', { name: 'project', exact: true });
        await projectName.click();
        await expect(projectHeading.getByRole('button', { name: 'Expand project' })).toBeVisible();
        await expect(running.page.locator('.session-list')).toHaveCount(0);
        await projectName.click();
        await expect(
            projectHeading.getByRole('button', { name: 'Collapse project' }),
        ).toBeVisible();
        await expect(running.page.locator('.session-list')).toBeVisible();
        const selectedSession = running.page.locator('.session-card.active');
        await selectedSession.focus();
        await expect(selectedSession).toHaveCSS('box-shadow', 'none');
        await running.page.mouse.move(500, 300);
        await expect(newSession).toHaveCSS('opacity', '0');
        await projectHeading.hover();
        await expect(newSession).toHaveCSS('opacity', '1');
        await running.page.mouse.move(500, 300);
        await newSession.focus();
        await expect(newSession).toHaveCSS('opacity', '1');
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

import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
} from './helpers.ts';

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
        const captionTitle = caption.locator(':scope > span').first();
        const collapse = caption.getByRole('button', { name: 'Collapse Folders' });
        await expect(captionTitle).toHaveText('project');
        await expect(captionTitle).toHaveAttribute('title', await realpath(root));
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
            /lucide-folder-closed/,
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

test('work tabs leave a draggable titlebar and keep New Terminal beside the last tab', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const strip = running.page.locator('.work-tabs');
        const tab = strip.locator('.work-tab').last();
        const actions = strip.locator('.tab-actions');
        const metrics = await Promise.all([
            strip.evaluate((element) => ({
                region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                right: element.getBoundingClientRect().right,
            })),
            tab.evaluate((element) => ({
                region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                right: element.getBoundingClientRect().right,
            })),
            actions.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return {
                    left: bounds.left,
                    region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                    right: bounds.right,
                };
            }),
        ]);

        expect(metrics[0].region).toBe('drag');
        expect(metrics[1].region).toBe('no-drag');
        expect(metrics[2].region).toBe('no-drag');
        expect(Math.abs(metrics[2].left - metrics[1].right)).toBeLessThanOrEqual(1);
        expect(metrics[0].right - metrics[2].right).toBeGreaterThan(100);
        await expect(running.page.getByRole('button', { name: 'Split Terminal' })).toHaveCount(0);

        const newTerminal = running.page.getByRole('button', { name: 'New Terminal' });
        await newTerminal.hover();
        const tooltip = running.page.locator('.tooltip-popup');
        await expect(tooltip).toContainText('Create a Terminal in the current Session');
        await expect(tooltip.locator('kbd')).toHaveText('⌘T');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Session archive hides active navigation without stopping Terminals and can restore', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-archive-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        await expect(running.page.locator('.session-card')).toHaveCount(2);
        const runningBeforeArchive = await pageRequest<number>(
            running.page,
            'terminal.runningCount',
        );

        const secondRow = sessionCard(running.page, secondSessionId).locator('..');
        await secondRow.hover();
        await secondRow.getByRole('button', { name: /^Archive / }).click();

        await expect(sessionCard(running.page, secondSessionId)).toHaveCount(0);
        await expect(sessionCard(running.page, firstSessionId)).toHaveClass(/active/);
        await expect
            .poll(() => pageRequest<number>(running.page, 'terminal.runningCount'))
            .toBe(runningBeforeArchive);
        const archived = running.page.getByRole('button', { name: /Archived 1/ });
        await archived.click();
        const restore = running.page.getByRole('button', { name: /^Restore / });
        await expect(restore.locator('svg')).toHaveCount(2);
        await restore.click();

        await expect(running.page.locator('.session-card')).toHaveCount(2);
        await expect(running.page.locator('.archived-sessions')).toHaveCount(0);
        const snapshot = await pageRequest<{
            sessions: Array<{ archivedAt?: number; id: string }>;
        }>(running.page, 'app.bootstrap');
        expect(
            snapshot.sessions.find((session) => session.id === secondSessionId)?.archivedAt,
        ).toBe(undefined);
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
        await expect(running.page.locator('.statusbar-toggle')).toHaveCount(0);

        await expect(running.page.locator('.session-sidebar')).toBeVisible();
        await running.page.keyboard.press('Meta+[');
        await expect(running.page.locator('.session-sidebar')).toHaveCount(0);
        await expect(running.page.locator('.collapsed-sidebar-titlebar')).toBeVisible();
        await running.page.keyboard.press('Meta+[');
        await expect(running.page.locator('.session-sidebar')).toBeVisible();

        await expect(running.page.locator('.inspector')).toBeVisible();
        await running.page.keyboard.press('Meta+]');
        await expect(running.page.locator('.inspector')).toHaveCount(0);
        await running.page.setViewportSize({ width: 800, height: 700 });
        await running.page.keyboard.press('Meta+]');
        await expect(running.page.locator('.inspector')).toBeVisible();
        expect(
            await running.page.locator('.app-shell').evaluate((element) => ({
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
            })),
        ).toEqual({ clientWidth: 800, scrollWidth: 800 });

        await running.page.keyboard.press('Meta+,');
        await expect(running.page.getByRole('dialog')).toContainText('Settings');
        await running.page.keyboard.press('Escape');
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        const paletteSearch = running.page.getByPlaceholder(
            'Search projects, sessions, and commands…',
        );
        await expect(paletteSearch).toBeFocused();
        await expect(palette.getByRole('button', { name: 'Close' })).toHaveCount(0);
        await paletteSearch.fill('new terminal');
        const terminalCommand = palette.getByRole('option').filter({ hasText: 'New Terminal' });
        await expect(terminalCommand).toBeVisible();
        await expect(terminalCommand.locator('kbd')).toHaveText('⌘T');
        await running.page.keyboard.press('Escape');
        await expect(palette).toHaveCount(0);

        const menuItems = await running.app.evaluate(({ Menu }) => {
            const menu = Menu.getApplicationMenu();
            return [
                'command.sidebar.toggle',
                'command.inspector.toggle',
                'command.settings.open',
                'command.commandPalette.open',
                'command.inspector.searchFiles',
                'command.workbench.closeActiveTab',
            ].map((id) => {
                const item = menu?.getMenuItemById(id);
                return item ? { accelerator: item.accelerator, id: item.id } : undefined;
            });
        });
        expect(menuItems).toEqual([
            { accelerator: 'Command+[', id: 'command.sidebar.toggle' },
            { accelerator: 'Command+]', id: 'command.inspector.toggle' },
            { accelerator: 'Command+,', id: 'command.settings.open' },
            { accelerator: 'Command+Shift+P', id: 'command.commandPalette.open' },
            { accelerator: 'Command+Shift+F', id: 'command.inspector.searchFiles' },
            { accelerator: 'Command+W', id: 'command.workbench.closeActiveTab' },
        ]);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

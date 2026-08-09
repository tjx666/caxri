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
    waitForRuntimeReady,
} from './helpers.ts';

const execFileAsync = promisify(execFile);

test('sidebar titlebar is logo-free and reveals Add Project on hover or focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-titlebar-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const titlebar = running.page.locator('.sidebar-title');
        const addProject = titlebar.getByRole('button', { name: 'Add Project' });
        await expect(titlebar.locator('[data-caxri-logo]')).toHaveCount(0);
        await expect(addProject).toHaveCSS('opacity', '0');
        await expect(addProject).toHaveCSS('pointer-events', 'none');
        const titlebarMetrics = await titlebar.evaluate((element) => {
            const titlebarBounds = element.getBoundingClientRect();
            return {
                appRegion: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
                height: titlebarBounds.height,
            };
        });
        expect(titlebarMetrics).toMatchObject({ appRegion: 'drag', height: 44 });
        await titlebar.hover({ position: { x: 90, y: 22 } });
        await expect(addProject).toHaveCSS('opacity', '1');
        await expect(addProject).toHaveCSS('pointer-events', 'auto');
        expect(
            await addProject.evaluate((element) =>
                getComputedStyle(element).getPropertyValue('-webkit-app-region'),
            ),
        ).toBe('no-drag');
        await running.page.mouse.move(500, 300);
        await addProject.focus();
        await expect(addProject).toHaveCSS('opacity', '1');
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

test('active and inactive Project navigation keeps full contrast', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-sidebar-contrast-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await createAdditionalShellSession(running.page);
        const cards = running.page.locator('.session-card');
        await expect(cards).toHaveCount(2);
        const colors = await Promise.all([
            running.page
                .locator('.project-heading')
                .evaluate((element) => getComputedStyle(element).color),
            cards.nth(0).evaluate((element) => getComputedStyle(element).color),
            cards.nth(1).evaluate((element) => getComputedStyle(element).color),
        ]);
        expect(new Set(colors).size).toBe(1);
        const backgrounds = await Promise.all([
            cards.nth(0).evaluate((element) => getComputedStyle(element).backgroundColor),
            cards.nth(1).evaluate((element) => getComputedStyle(element).backgroundColor),
        ]);
        expect(backgrounds[0]).not.toBe(backgrounds[1]);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Session inline rename validates input and survives Renderer reload', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-rename-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const sessionId = await selectedSessionId(running.page);
        const card = sessionCard(running.page, sessionId);
        await card.dblclick();
        const input = card.getByRole('textbox', { name: 'Rename Shell' });
        await expect(input).toBeFocused();
        expect(
            await input.evaluate((element) => ({
                end: (element as HTMLInputElement).selectionEnd,
                start: (element as HTMLInputElement).selectionStart,
                value: (element as HTMLInputElement).value,
            })),
        ).toEqual({ end: 5, start: 0, value: 'Shell' });

        await input.fill('   ');
        await input.press('Enter');
        await expect(input).toHaveAttribute('aria-invalid', 'true');
        await expect(card.getByRole('alert')).toHaveText('Session name is required');
        await input.press('Escape');
        await expect(card.locator('strong')).toHaveText('Shell');
        await expect(card).toBeFocused();

        await card.focus();
        await card.press('Enter');
        const keyboardInput = card.getByRole('textbox', { name: 'Rename Shell' });
        await keyboardInput.fill('Manual investigation');
        await keyboardInput.press('Enter');
        await expect(card.locator('strong')).toHaveText('Manual investigation');
        await expect(card).toBeFocused();
        const state = await pageRequest<{
            sessions: Array<{ displayTitle: string; id: string; titleMode: string }>;
        }>(running.page, 'app.bootstrap');
        expect(state.sessions.find((session) => session.id === sessionId)).toMatchObject({
            displayTitle: 'Manual investigation',
            titleMode: 'manual',
        });

        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect(sessionCard(running.page, sessionId).locator('strong')).toHaveText(
            'Manual investigation',
        );
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Session rows support keyboard selection independently from rename', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-keyboard-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        expect(secondSessionId).not.toBe(firstSessionId);

        const firstCard = sessionCard(running.page, firstSessionId);
        const newSession = running.page.getByRole('button', {
            name: 'New Session in project',
        });
        await newSession.focus();
        await running.page.keyboard.press('Tab');
        await expect(firstCard).toBeFocused();
        expect(await firstCard.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe(
            'none',
        );
        await firstCard.press('Space');
        await expect(firstCard).toHaveClass(/active/);
        expect(await selectedSessionId(running.page)).toBe(firstSessionId);
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

        const alignedBottoms = async (...selectors: string[]) =>
            Promise.all(
                selectors.map((selector) =>
                    running.page
                        .locator(selector)
                        .evaluate((element) => element.getBoundingClientRect().bottom),
                ),
            );
        const assertAligned = (values: number[]): void => {
            expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
        };
        assertAligned(await alignedBottoms('.sidebar-title', '.work-tabs', '.inspector-tabs'));
        await running.page.keyboard.press('Meta+[');
        assertAligned(
            await alignedBottoms('.collapsed-sidebar-titlebar', '.work-tabs', '.inspector-tabs'),
        );
        await running.page.keyboard.press('Meta+[');
        await running.page.keyboard.press('Meta+]');
        assertAligned(await alignedBottoms('.sidebar-title', '.work-tabs'));
        await running.page.keyboard.press('Meta+]');

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

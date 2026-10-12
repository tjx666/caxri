import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest } from './support/helpers.ts';

/**
 * `window.zoomLevel` is one app-wide setting. The Commander opens at it, follows every change, and keeps its traffic
 * lights centered in its zoomed header; View > Zoom In from the Commander zooms it in place rather than being dropped,
 * even while a Workbench dialog is open.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander window follows the app zoom and zooms from its own shortcut', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-zoom-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const zoomOf = () =>
        running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
                .map((window) => ({
                    commander: window.webContents.getURL().includes('agent-commander.html'),
                    level: window.webContents.getZoomLevel(),
                    buttons: window.getWindowButtonPosition(),
                }))
                .toSorted((left, right) => Number(left.commander) - Number(right.commander)),
        );
    /**
     * Electron hands a menu item's click the focused window; passing the Commander's reproduces its Cmd+= without
     * depending on which app macOS has in front during the run.
     */
    const zoomInFromCommander = () =>
        running.app.evaluate(({ BrowserWindow, Menu }) => {
            const window = BrowserWindow.getAllWindows().find((candidate) =>
                candidate.webContents.getURL().includes('agent-commander.html'),
            );
            const item = Menu.getApplicationMenu()?.getMenuItemById('command.view.zoomIn');
            if (!window || !item) throw new Error('Commander window or Zoom In is missing');
            (item.click as (...parameters: unknown[]) => void)(
                { triggeredByAccelerator: true },
                window,
                window.webContents,
            );
        });
    try {
        await createShellSession(running.page);
        const settings = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        settings.value['window.zoomLevel'] = 1;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings.value),
        });
        await expect.poll(async () => (await zoomOf()).map(({ level }) => level)).toEqual([1]);

        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        await expect(commander.locator('.terminal-pane .xterm-rows')).toContainText(
            'Fake codex ready',
        );
        await expect
            .poll(zoomOf)
            .toEqual([
                expect.objectContaining({ commander: false, level: 1 }),
                { commander: true, level: 1, buttons: { x: 15, y: 19 } },
            ]);
        await expect
            .poll(() =>
                commander.evaluate(() =>
                    document.documentElement.style.getPropertyValue('--window-zoom-factor'),
                ),
            )
            .toBe('1.2');

        await zoomInFromCommander();
        await expect
            .poll(zoomOf)
            .toEqual([
                expect.objectContaining({ commander: false, level: 2 }),
                { commander: true, level: 2, buttons: { x: 15, y: 25 } },
            ]);

        // A Workbench dialog the user cannot see from the Commander blocks other commands, but not zoom.
        await running.page.keyboard.press('Meta+Shift+F');
        await expect(running.page.locator('.project-search')).toBeVisible();
        await zoomInFromCommander();
        await expect
            .poll(zoomOf)
            .toEqual([
                expect.objectContaining({ commander: false, level: 3 }),
                { commander: true, level: 3, buttons: { x: 15, y: 31 } },
            ]);
        await expect(running.page.locator('.project-search')).toBeVisible();
        await testInfo.attach('commander-zoomed', {
            body: await commander.screenshot(),
            contentType: 'image/png',
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * MacOS fullscreen hides the traffic lights, so the Commander title bar drops their clearance and shows the logo. The
 * Commander window publishes its own state; the Workbench receives the same durable event and must ignore it. The
 * native transition is simulated on the real `BrowserWindow`, because a locked CI console cannot enter a fullscreen
 * Space.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander title bar swaps the traffic-light clearance for the logo in fullscreen', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-fullscreen-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const setCommanderFullScreen = (isFullScreen: boolean) =>
        running.app.evaluate(({ BrowserWindow }, nextFullScreen) => {
            const window = BrowserWindow.getAllWindows().find((candidate) =>
                candidate.webContents.getURL().includes('agent-commander.html'),
            );
            if (!window) throw new Error('Commander window is missing');
            window.isFullScreen = () => nextFullScreen;
            window.emit(nextFullScreen ? 'enter-full-screen' : 'leave-full-screen');
        }, isFullScreen);
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        const header = commander.locator('.agent-commander-header');
        await expect(header).toBeVisible();
        await expect(header.locator('[data-caxri-logo]')).toHaveCount(0);
        await expect(header).toHaveCSS('padding-left', '78px');

        await setCommanderFullScreen(true);
        await expect(header.locator('img[data-caxri-logo]')).toBeVisible();
        await expect(header).toHaveCSS('padding-left', '12px');
        await expect(running.page.locator('.primary-sidebar-title [data-caxri-logo]')).toHaveCount(
            0,
        );

        await setCommanderFullScreen(false);
        await expect(header.locator('[data-caxri-logo]')).toHaveCount(0);
        await expect(header).toHaveCSS('padding-left', '78px');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * The Commander keeps running after its window closes, and the user reopens the window many times a day. It comes back
 * where the user left it rather than at the default size in the middle of the screen.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander window reopens where it was closed', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-bounds-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const commanderBounds = () =>
        running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('agent-commander.html'))
                ?.getBounds(),
        );
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const moved = { x: 40, y: 60, width: 900, height: 600 };
        await running.app.evaluate(({ BrowserWindow }, bounds) => {
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('agent-commander.html'))
                ?.setBounds(bounds);
        }, moved);
        await expect.poll(commanderBounds).toEqual(moved);

        await running.app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('agent-commander.html'))
                ?.close();
        });
        await expect.poll(() => running.app.windows().length).toBe(1);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);

        await expect.poll(commanderBounds).toEqual(moved);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * A Commander window still open when the app quits reopens itself, at the same bounds, the next time the app launches:
 * cold-start reopen plus cross-restart bounds persistence together; see `reopenAuxiliaryWindowsAtStartup` and
 * `AgentCommanderWindowController.persistWindowState`.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander window reopens at its remembered bounds across an app restart', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-restart-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    let running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const commanderBounds = () =>
        running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('agent-commander.html'))
                ?.getBounds(),
        );
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const moved = { x: 50, y: 70, width: 1_000, height: 700 };
        await running.app.evaluate(({ BrowserWindow }, bounds) => {
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('agent-commander.html'))
                ?.setBounds(bounds);
        }, moved);
        await expect.poll(commanderBounds).toEqual(moved);

        // A real quit (not just closing the window) is what flushes `persistWindowState` at `before-quit`.
        await running.app.close();
        running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });

        // The Commander was still open when the app quit, so it reopens on its own, at the bounds it was left at.
        await expect.poll(() => running.app.windows().length).toBe(2);
        await expect.poll(commanderBounds).toEqual(moved);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        await expect(commander.locator('.terminal-pane .xterm-rows')).toContainText(
            'Fake codex ready',
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});

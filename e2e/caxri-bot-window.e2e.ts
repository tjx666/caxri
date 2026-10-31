import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { openCaxriBot } from './support/caxri-bot.ts';
import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest } from './support/helpers.ts';

/**
 * `window.zoomLevel` is one app-wide setting. Caxri Bot opens at it, follows every change, and keeps its traffic lights
 * centered in its zoomed header; View > Zoom In from Caxri Bot zooms it in place rather than being dropped, even while
 * a Workbench dialog is open.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot window follows the app zoom and zooms from its own shortcut', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-zoom-e2e-'));
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
                    bot: window.webContents.getURL().includes('caxri-bot.html'),
                    level: window.webContents.getZoomLevel(),
                    buttons: window.getWindowButtonPosition(),
                }))
                .toSorted((left, right) => Number(left.bot) - Number(right.bot)),
        );
    /**
     * Electron hands a menu item's click the focused window; passing Caxri Bot's reproduces its Cmd+= without depending
     * on which app macOS has in front during the run.
     */
    const zoomInFromBot = () =>
        running.app.evaluate(({ BrowserWindow, Menu }) => {
            const window = BrowserWindow.getAllWindows().find((candidate) =>
                candidate.webContents.getURL().includes('caxri-bot.html'),
            );
            const item = Menu.getApplicationMenu()?.getMenuItemById('command.view.zoomIn');
            if (!window || !item) throw new Error('Caxri Bot window or Zoom In is missing');
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

        await openCaxriBot(running.page);
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        await expect(bot.locator('.terminal-pane .xterm-rows')).toContainText('Fake codex ready');
        await expect
            .poll(zoomOf)
            .toEqual([
                expect.objectContaining({ bot: false, level: 1 }),
                { bot: true, level: 1, buttons: { x: 15, y: 15 } },
            ]);
        await expect
            .poll(() =>
                bot.evaluate(() =>
                    document.documentElement.style.getPropertyValue('--window-zoom-factor'),
                ),
            )
            .toBe('1.2');

        await zoomInFromBot();
        await expect
            .poll(zoomOf)
            .toEqual([
                expect.objectContaining({ bot: false, level: 2 }),
                { bot: true, level: 2, buttons: { x: 15, y: 19 } },
            ]);

        // A Workbench dialog the user cannot see from Caxri Bot blocks other commands, but not zoom.
        await running.page.keyboard.press('Meta+Shift+F');
        await expect(running.page.locator('.project-search')).toBeVisible();
        await zoomInFromBot();
        await expect
            .poll(zoomOf)
            .toEqual([
                expect.objectContaining({ bot: false, level: 3 }),
                { bot: true, level: 3, buttons: { x: 15, y: 24 } },
            ]);
        await expect(running.page.locator('.project-search')).toBeVisible();
        await testInfo.attach('bot-zoomed', {
            body: await bot.screenshot(),
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
 * MacOS fullscreen hides the traffic lights, so the Caxri Bot title bar drops their clearance and shows the logo. The
 * The Caxri Bot window publishes its own state; the Workbench receives the same durable event and must ignore it. The
 * native transition is simulated on the real `BrowserWindow`, because a locked CI console cannot enter a fullscreen
 * Space.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot title bar swaps the traffic-light clearance for the logo in fullscreen', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-fullscreen-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const setBotFullScreen = (isFullScreen: boolean) =>
        running.app.evaluate(({ BrowserWindow }, nextFullScreen) => {
            const window = BrowserWindow.getAllWindows().find((candidate) =>
                candidate.webContents.getURL().includes('caxri-bot.html'),
            );
            if (!window) throw new Error('Caxri Bot window is missing');
            window.isFullScreen = () => nextFullScreen;
            window.emit(nextFullScreen ? 'enter-full-screen' : 'leave-full-screen');
        }, isFullScreen);
    try {
        await createShellSession(running.page);
        await openCaxriBot(running.page);
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        const header = bot.locator('.caxri-bot-header');
        await expect(header).toBeVisible();
        await expect(header.locator('[data-caxri-logo]')).toHaveCount(0);
        await expect(header).toHaveCSS('padding-left', '78px');

        await setBotFullScreen(true);
        await expect(header.locator('img[data-caxri-logo]')).toBeVisible();
        await expect(header).toHaveCSS('padding-left', '12px');
        await expect(running.page.locator('.primary-sidebar-title [data-caxri-logo]')).toHaveCount(
            0,
        );

        await setBotFullScreen(false);
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
 * A window reloaded while fullscreen (dev full-page reload, Renderer crash recovery) keeps its fullscreen chrome. Once
 * more durable events have been published than the event journal retains, a fresh Renderer recovers from a snapshot
 * that carries no window state, so the title bar cannot depend on replaying the last `window.fullScreen` push.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Workbench and Caxri Bot keep the fullscreen title bar after a reload', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-fullscreen-reload-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await openCaxriBot(running.page);
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        const botHeader = bot.locator('.caxri-bot-header');
        const workbenchTitle = running.page.locator('.primary-sidebar-title');
        await expect(botHeader).toBeVisible();

        // Both windows enter fullscreen, then enough further durable events follow to push that transition (and
        // everything before it) out of the event journal.
        await running.app.evaluate(({ BrowserWindow }) => {
            for (const window of BrowserWindow.getAllWindows()) {
                window.isFullScreen = () => true;
                window.emit('enter-full-screen');
            }
            const botWindow = BrowserWindow.getAllWindows().find((candidate) =>
                candidate.webContents.getURL().includes('caxri-bot.html'),
            );
            if (!botWindow) throw new Error('Caxri Bot window is missing');
            for (let index = 0; index < 300; index += 1) botWindow.emit('enter-full-screen');
        });
        await expect(botHeader.locator('img[data-caxri-logo]')).toBeVisible();
        await expect(workbenchTitle.locator('img[data-caxri-logo]')).toBeVisible();

        await Promise.all([running.page.reload(), bot.reload()]);
        await expect(botHeader).toBeVisible();
        await expect(botHeader.locator('img[data-caxri-logo]')).toBeVisible();
        await expect(botHeader).toHaveCSS('padding-left', '12px');
        await expect(workbenchTitle.locator('img[data-caxri-logo]')).toBeVisible();
        await expect(workbenchTitle).toHaveCSS('padding-left', '12px');
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
 * Caxri Bot keeps running after its window closes, and the user reopens the window many times a day. It comes back
 * where the user left it rather than at the default size in the middle of the screen.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot window reopens where it was closed', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-bounds-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const botBounds = () =>
        running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('caxri-bot.html'))
                ?.getBounds(),
        );
    try {
        await createShellSession(running.page);
        await openCaxriBot(running.page);
        await expect.poll(() => running.app.windows().length).toBe(2);
        const moved = { x: 40, y: 60, width: 900, height: 600 };
        await running.app.evaluate(({ BrowserWindow }, bounds) => {
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('caxri-bot.html'))
                ?.setBounds(bounds);
        }, moved);
        await expect.poll(botBounds).toEqual(moved);

        await running.app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('caxri-bot.html'))
                ?.close();
        });
        await expect.poll(() => running.app.windows().length).toBe(1);
        await openCaxriBot(running.page);
        await expect.poll(() => running.app.windows().length).toBe(2);

        await expect.poll(botBounds).toEqual(moved);
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
 * A Caxri Bot window still open when the app quits reopens itself, at the same bounds, the next time the app launches:
 * cold-start reopen plus cross-restart bounds persistence together; see `reopenAuxiliaryWindowsAtStartup` and
 * `CaxriBotWindowController.persistWindowState`.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot window reopens at its remembered bounds across an app restart', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-restart-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        /**
         * A late banner reproduces the loaded runner of issue #1871, where the app quit before the Agent printed
         * anything; the spec must wait for it instead of winning the race on a fast machine.
         */
        providers: { codex: { readinessDelayMs: 1_000 } },
    });
    let running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const botBounds = () =>
        running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('caxri-bot.html'))
                ?.getBounds(),
        );
    try {
        await createShellSession(running.page);
        await openCaxriBot(running.page);
        await expect.poll(() => running.app.windows().length).toBe(2);
        const moved = { x: 50, y: 70, width: 1_000, height: 700 };
        await running.app.evaluate(({ BrowserWindow }, bounds) => {
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('caxri-bot.html'))
                ?.setBounds(bounds);
        }, moved);
        await expect.poll(botBounds).toEqual(moved);
        /**
         * The default quit choice is Quit and Stop Tasks, which ends the Caxri Bot Terminal as `stopped` by design, so
         * the relaunched pane shows only the persisted scrollback. Quitting before the Agent's first output would
         * persist an empty screen (issue #1871).
         */
        const opened = running.app.windows().find((page) => page !== running.page)!;
        await expect(opened.locator('.terminal-pane .xterm-rows')).toContainText(
            'Fake codex ready',
        );

        // A real quit (not just closing the window) is what flushes `persistWindowState` at `before-quit`.
        await running.app.close();
        running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });

        // Caxri Bot was still open when the app quit, so it reopens on its own, at the bounds it was left at.
        await expect.poll(() => running.app.windows().length).toBe(2);
        await expect.poll(botBounds).toEqual(moved);
        // The Terminal was stopped by the quit, not restored: this is its persisted scrollback.
        const bot = running.app.windows().find((page) => page !== running.page)!;
        await expect(bot.locator('.terminal-pane .xterm-rows')).toContainText('Fake codex ready');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

import type { BotSnapshot, BotStatus } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { dropFinderFiles } from './support/finder-file-drop.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    waitForRuntimeReady,
} from './support/helpers.ts';
import { chooseContextMenuItem, contextMenuLabels } from './support/native-context-menu.ts';
import { readFileForPoll } from './support/result-file-polling.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot keeps running after its window closes and stops on request', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const botWindow = async () => {
        await expect.poll(() => running.app.windows().length).toBe(2);
        return running.app.windows().find((page) => page !== running.page)!;
    };
    try {
        await createShellSession(running.page);
        const chip = running.page.locator('.bot-status-chip');
        await expect(chip).toHaveCount(0);

        await pageRequest(running.page, 'caxriBot.open');
        const firstWindow = await botWindow();
        await expect(chip).toContainText('Caxri Bot');
        const { identity } = await pageRequest<BotSnapshot>(running.page, 'bot.snapshot');

        await firstWindow.close();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(chip).toContainText('Caxri Bot');
        await testInfo.attach('bot-running-in-background', {
            body: await chip.screenshot(),
            contentType: 'image/png',
        });

        await running.app.evaluate(({ Menu }) => {
            Menu.getApplicationMenu()?.getMenuItemById('command.caxriBot.stop')?.click();
        });
        await expect(chip).toHaveCount(0);
        await expect
            .poll(() => pageRequest<BotStatus>(running.page, 'bot.status'))
            .toEqual({ state: 'stopped' });

        await pageRequest(running.page, 'caxriBot.open');
        const reopenedWindow = await botWindow();
        await expect(chip).toContainText('Caxri Bot');
        const reopened = await pageRequest<BotSnapshot>(running.page, 'bot.snapshot');
        expect(reopened.identity).toEqual(identity);

        // Stop sits in the title bar's More menu, below the commands used more often.
        await reopenedWindow.getByRole('button', { name: 'More', exact: true }).click();
        await reopenedWindow.getByRole('menuitem', { name: 'Stop Caxri Bot', exact: true }).click();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(chip).toHaveCount(0);
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
 * The native menu belongs to the whole app, so Close Tab pressed in the Caxri Bot window used to close the active tab
 * of the Workbench behind it. It must close the Caxri Bot window instead and leave Caxri Bot running.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Close Tab in the focused Caxri Bot window closes that window, not a Workbench tab', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-menu-e2e-'));
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
        const workbenchTerminals = running.page.locator('.terminal-pane');
        await expect(workbenchTerminals).toHaveCount(1);
        await pageRequest(running.page, 'caxriBot.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        await expect(running.page.locator('.bot-status-chip')).toContainText('Caxri Bot');

        /**
         * Electron hands a menu item's click the focused window; passing Caxri Bot's reproduces its Cmd+W without
         * depending on which app macOS has in front during the run.
         */
        await running.app.evaluate(({ BrowserWindow, Menu }) => {
            const bot = BrowserWindow.getAllWindows().find((window) =>
                window.webContents.getURL().includes('caxri-bot.html'),
            );
            const item = Menu.getApplicationMenu()?.getMenuItemById(
                'command.workbench.closeActiveTab',
            );
            if (!bot || !item) throw new Error('Caxri Bot window or Close Tab is missing');
            (item.click as (...parameters: unknown[]) => void)(
                { triggeredByAccelerator: true },
                bot,
                bot.webContents,
            );
        });

        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(workbenchTerminals).toHaveCount(1);
        await expect
            .poll(() => pageRequest<BotStatus>(running.page, 'bot.status'))
            .not.toEqual({ state: 'stopped' });
        await testInfo.attach('workbench-after-bot-close-tab', {
            body: await running.page.locator('.bot-status-chip').screenshot(),
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
 * The Caxri Bot Terminal is an ordinary Terminal pane, so its right-click menu must open over the Caxri Bot window and
 * its entries must act on the Caxri Bot Terminal, not be refused by the window's request policy.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot Terminal opens its context menu in Caxri Bot window', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-context-menu-e2e-'));
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
        await pageRequest(running.page, 'caxriBot.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        const pane = bot.locator('.terminal-pane');
        await expect(pane.locator('.terminal-surface')).toHaveAttribute(
            'data-terminal-attached',
            'true',
        );

        await pane.locator('.xterm-screen').click({ button: 'right' });
        expect(await contextMenuLabels(running.app)).toEqual(
            expect.arrayContaining(['Copy', 'Paste', 'Clear', 'Find in Terminal']),
        );
        await chooseContextMenuItem(running.app, 'Find in Terminal');

        const search = bot.getByRole('textbox', { name: 'Find in Terminal', exact: true });
        await expect(search).toBeFocused();
        await testInfo.attach('bot-terminal-find', {
            body: await bot.locator('.terminal-search').screenshot(),
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
 * Server Core restart takes every PTY with it, and the Server restores only the selected Session, which is never the
 * Caxri Bot's. An open window must bring Caxri Bot back itself instead of showing a Terminal nothing restarts.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot restarts under its open window after Server Core restarts', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-restart-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const argumentsCapturePath = join(directory, 'codex-arguments.jsonl');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { argumentsCapturePath } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const status = () => pageRequest<BotStatus>(running.page, 'bot.status');
    const readLaunches = async (): Promise<string[][]> => {
        let text: string;
        try {
            text = await readFile(argumentsCapturePath, 'utf8');
        } catch {
            return [];
        }
        return text
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[]);
    };
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'caxriBot.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        await expect.poll(status).not.toEqual({ state: 'stopped' });
        /**
         * Kill the Server only once the pane settled: a mounting pane attaches, then writes its Session state on focus,
         * and a write the kill cuts off reports its own failure, which is not the failure this test is about.
         */
        const pane = bot.locator('.terminal-pane');
        await expect(pane.locator('.terminal-surface')).toHaveAttribute(
            'data-terminal-attached',
            'true',
        );
        await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
        const isBotStateSettled = async () => {
            const { identity, workbench } = await pageRequest<BotSnapshot>(
                running.page,
                'bot.snapshot',
            );
            const shown = await bot.evaluate(
                (sessionId) =>
                    (
                        globalThis as unknown as {
                            __caxriStores: {
                                getState: (name: string) => {
                                    bootstrap?: { sessionStates: Array<{ sessionId: string }> };
                                };
                            };
                        }
                    ).__caxriStores
                        .getState('workbench')
                        .bootstrap?.sessionStates.find((state) => state.sessionId === sessionId),
                identity.sessionId,
            );
            const stored = workbench.sessionStates.find(
                (state) => state.sessionId === identity.sessionId,
            );
            return isDeepStrictEqual(shown, stored);
        };
        await expect.poll(isBotStateSettled).toBe(true);
        /**
         * The attached pane only proves the PTY exists; the fake Codex records its argv once its own Node process
         * starts, which a loaded runner can delay past the restart below. Wait for that launch first so the count after
         * the restart measures the restore launch, not startup latency.
         */
        await expect.poll(readLaunches).toHaveLength(1);

        const before = await pageRequest<{ pid: number }>(running.page, 'host.status');
        process.kill(before.pid, 'SIGKILL');
        /**
         * Polls for a replacement PID rather than the brief `restarting` status, which a slow poll can miss. A request
         * sent while no Server is connected fails, which reads as not replaced yet.
         */
        const isServerReplaced = async () => {
            try {
                const { pid } = await pageRequest<{ pid: number }>(running.page, 'host.status');
                return pid !== before.pid;
            } catch {
                return false;
            }
        };
        await expect.poll(isServerReplaced, { timeout: 30_000 }).toBe(true);
        await waitForRuntimeReady(running.page);

        const botTerminalState = async () => {
            const { identity, workbench } = await pageRequest<BotSnapshot>(
                running.page,
                'bot.snapshot',
            );
            return workbench.terminals.find(({ id }) => id === identity.terminalId)
                ?.lastProcessState;
        };
        await expect.poll(botTerminalState, { timeout: 30_000 }).toBe('running');
        await expect(bot.getByText('Interrupted by app shutdown')).toHaveCount(0);
        /**
         * The restart took Caxri Bot's PTY with it, so the open window relaunched Codex (`docs/caxri-bot.md`). That
         * restore launch must trust the workspace exactly like the first one, or Codex would stop at its folder-trust
         * prompt instead of coming back.
         */
        const workspace = await realpath(join(userData, 'agent-commander'));
        const trust = `projects={ ${JSON.stringify(workspace)} = { trust_level = "trusted" } }`;
        await expect.poll(readLaunches, { timeout: 30_000 }).toHaveLength(2);
        const launches = await readLaunches();
        for (const launch of launches) expect(launch[launch.indexOf(trust) - 1]).toBe('-c');
        await expect.poll(status).not.toEqual({ state: 'stopped' });
        await expect(running.page.locator('.bot-status-chip')).toContainText('Caxri Bot');
        await testInfo.attach('bot-after-server-restart', {
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

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot Terminal runs the shortcuts its context menu offers', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-shortcuts-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { startupOutput: 'Caxri Bot notes at https://example.com/bot' } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'caxriBot.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        const pane = bot.locator('.terminal-pane');
        await expect(pane.locator('.xterm-rows')).toContainText('https://example.com/bot');
        const terminalInput = pane.locator('.xterm-helper-textarea');

        await terminalInput.press('Meta+Shift+O');
        const picker = bot.getByRole('dialog', { name: 'Open Detected Link' });
        await expect(
            picker.getByRole('option', {
                name: 'Open external link https://example.com/bot',
                exact: true,
            }),
        ).toBeVisible();
        await testInfo.attach('bot-shortcut-detected-links', {
            body: await bot.screenshot(),
            contentType: 'image/png',
        });
        await bot.keyboard.press('Escape');
        await expect(picker).toBeHidden();

        await terminalInput.press('Meta+f');
        const search = bot.getByRole('textbox', { name: 'Find in Terminal', exact: true });
        await expect(search).toBeFocused();
        await testInfo.attach('bot-shortcut-find', {
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
 * A Caxri Bot that quits on `Ctrl+D`, as the Codex CLI does, which hands its Terminal back to the Shell underneath.
 */
const QUITTING_BOT_SOURCE = `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0); }
if (process.argv[2] === 'app-server') process.exit(0);
process.stdout.write('Caxri Bot is running');
process.stdin.setRawMode?.(true);
process.stdin.on('data', (data) => {
  if (data.includes(4)) process.stdout.write(' Caxri Bot quit', () => process.exit(0));
});
`;

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot Terminal restarts from its shortcut after it exits', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-restart-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { executableSource: QUITTING_BOT_SOURCE } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'caxriBot.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        const pane = bot.locator('.terminal-pane');
        const terminalInput = pane.locator('.xterm-helper-textarea');
        const botTerminal = async () => {
            const { identity, workbench } = await pageRequest<BotSnapshot>(
                running.page,
                'bot.snapshot',
            );
            return workbench.terminals.find(({ id }) => id === identity.terminalId);
        };
        await expect(pane.locator('.xterm-rows')).toContainText('Caxri Bot is running');
        const exitedProcessId = (await botTerminal())?.processId;

        await terminalInput.press('Control+d');
        // The Agent quits back to its Shell; typing before it is gone would feed the Agent instead.
        await expect(pane.locator('.xterm-rows')).toContainText('Caxri Bot quit');
        await terminalInput.pressSequentially('exit');
        await terminalInput.press('Enter');
        const stopped = bot.locator('[data-terminal-exit-state="stopped"]');
        await expect(stopped).toContainText('Process exited normally');

        await bot.keyboard.press('Meta+Shift+R');
        await expect(stopped).toHaveCount(0);
        await expect
            .poll(async () => {
                const terminal = await botTerminal();
                return (
                    terminal?.lastProcessState === 'running' &&
                    terminal.processId !== exitedProcessId
                );
            })
            .toBe(true);
        await testInfo.attach('bot-restarted-from-shortcut', {
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

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Caxri Bot Terminal inserts the path of a screenshot dropped from Finder', async ({}, testInfo) => {
    const directory = await realpath(await mkdtemp(`${tmpdir()}/caxri-bot-drop-e2e-`));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const screenshot = join(directory, 'Screenshot 2026-09-28 at 07.40.png');
    await writeFile(screenshot, 'fixture\n');
    const capture = join(directory, 'bot-input.txt');
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { inputCapture: { path: capture, encoding: 'utf8' } } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'caxriBot.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const bot = running.app.windows().find((page) => page !== running.page)!;
        const pane = bot.locator('.terminal-pane');
        await expect(pane.locator('.xterm-rows')).toContainText('Fake codex ready');

        await dropFinderFiles(bot, pane, [screenshot]);

        // Caxri Bot works outside every Project, so the path stays absolute, quoted for its spaces.
        await expect
            .poll(() => readFileForPoll(() => readFile(capture, 'utf8')))
            .toBe(`'${screenshot}'\n`);
        await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
        await testInfo.attach('bot-finder-drop', {
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

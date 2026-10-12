import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

import type { CommanderSnapshot, CommanderStatus } from '@caxri/protocol';

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
test('Agent Commander keeps running after its window closes and stops on request', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const commanderWindow = async () => {
        await expect.poll(() => running.app.windows().length).toBe(2);
        return running.app.windows().find((page) => page !== running.page)!;
    };
    try {
        await createShellSession(running.page);
        const chip = running.page.locator('.commander-status-chip');
        await expect(chip).toHaveCount(0);

        await pageRequest(running.page, 'agentCommander.open');
        const firstWindow = await commanderWindow();
        await expect(chip).toContainText('Commander');
        const { identity } = await pageRequest<CommanderSnapshot>(
            running.page,
            'commander.snapshot',
        );

        await firstWindow.close();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(chip).toContainText('Commander');
        await testInfo.attach('commander-running-in-background', {
            body: await chip.screenshot(),
            contentType: 'image/png',
        });

        await running.app.evaluate(({ Menu }) => {
            Menu.getApplicationMenu()?.getMenuItemById('command.agentCommander.stop')?.click();
        });
        await expect(chip).toHaveCount(0);
        await expect
            .poll(() => pageRequest<CommanderStatus>(running.page, 'commander.status'))
            .toEqual({ state: 'stopped' });

        await pageRequest(running.page, 'agentCommander.open');
        const reopenedWindow = await commanderWindow();
        await expect(chip).toContainText('Commander');
        const reopened = await pageRequest<CommanderSnapshot>(running.page, 'commander.snapshot');
        expect(reopened.identity).toEqual(identity);

        await reopenedWindow.getByRole('button', { name: 'Stop', exact: true }).click();
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
 * The native menu belongs to the whole app, so Close Tab pressed in the Commander window used to close the active tab
 * of the Workbench behind it. It must close the Commander window instead and leave the Commander running.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Close Tab in the focused Agent Commander window closes that window, not a Workbench tab', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-menu-e2e-'));
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
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        await expect(running.page.locator('.commander-status-chip')).toContainText('Commander');

        /**
         * Electron hands a menu item's click the focused window; passing the Commander's reproduces its Cmd+W without
         * depending on which app macOS has in front during the run.
         */
        await running.app.evaluate(({ BrowserWindow, Menu }) => {
            const commander = BrowserWindow.getAllWindows().find((window) =>
                window.webContents.getURL().includes('agent-commander.html'),
            );
            const item = Menu.getApplicationMenu()?.getMenuItemById(
                'command.workbench.closeActiveTab',
            );
            if (!commander || !item) throw new Error('Commander window or Close Tab is missing');
            (item.click as (...parameters: unknown[]) => void)(
                { triggeredByAccelerator: true },
                commander,
                commander.webContents,
            );
        });

        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(workbenchTerminals).toHaveCount(1);
        await expect
            .poll(() => pageRequest<CommanderStatus>(running.page, 'commander.status'))
            .not.toEqual({ state: 'stopped' });
        await testInfo.attach('workbench-after-commander-close-tab', {
            body: await running.page.locator('.commander-status-chip').screenshot(),
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
 * The Commander Terminal is an ordinary Terminal pane, so its right-click menu must open over the Commander window and
 * its entries must act on the Commander Terminal, not be refused by the window's request policy.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander Terminal opens its context menu in the Commander window', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-context-menu-e2e-'));
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
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        const pane = commander.locator('.terminal-pane');
        await expect(pane.locator('.terminal-surface')).toHaveAttribute(
            'data-terminal-attached',
            'true',
        );

        await pane.locator('.xterm-screen').click({ button: 'right' });
        expect(await contextMenuLabels(running.app)).toEqual(
            expect.arrayContaining(['Copy', 'Paste', 'Clear', 'Find in Terminal']),
        );
        await chooseContextMenuItem(running.app, 'Find in Terminal');

        const search = commander.getByRole('textbox', { name: 'Find in Terminal', exact: true });
        await expect(search).toBeFocused();
        await testInfo.attach('commander-terminal-find', {
            body: await commander.locator('.terminal-search').screenshot(),
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
 * Commander's. An open window must bring its Commander back itself instead of showing a Terminal nothing restarts.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander restarts under its open window after Server Core restarts', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-restart-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const argumentsCapturePath = join(directory, 'codex-arguments.jsonl');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { argumentsCapturePath } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const status = () => pageRequest<CommanderStatus>(running.page, 'commander.status');
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        await expect.poll(status).not.toEqual({ state: 'stopped' });
        /**
         * Kill the Server only once the pane settled: a mounting pane attaches, then writes its Session state on focus,
         * and a write the kill cuts off reports its own failure, which is not the failure this test is about.
         */
        const pane = commander.locator('.terminal-pane');
        await expect(pane.locator('.terminal-surface')).toHaveAttribute(
            'data-terminal-attached',
            'true',
        );
        await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
        const isCommanderStateSettled = async () => {
            const { identity, workbench } = await pageRequest<CommanderSnapshot>(
                running.page,
                'commander.snapshot',
            );
            const shown = await commander.evaluate(
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
        await expect.poll(isCommanderStateSettled).toBe(true);

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

        const commanderTerminalState = async () => {
            const { identity, workbench } = await pageRequest<CommanderSnapshot>(
                running.page,
                'commander.snapshot',
            );
            return workbench.terminals.find(({ id }) => id === identity.terminalId)
                ?.lastProcessState;
        };
        await expect.poll(commanderTerminalState, { timeout: 30_000 }).toBe('running');
        await expect(commander.getByText('Interrupted by app shutdown')).toHaveCount(0);
        /**
         * The Terminal Host outlives Server Core, so Codex keeps running rather than relaunching. Its one launch
         * trusted the workspace for that process only, so it never stopped at Codex's folder-trust prompt. Restore and
         * restart build their argv through the same planner call, covered by `launch-plan.test.ts`.
         */
        const workspace = await realpath(join(userData, 'agent-commander'));
        const trust = `projects={ ${JSON.stringify(workspace)} = { trust_level = "trusted" } }`;
        const launches = (await readFile(argumentsCapturePath, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as string[]);
        expect(launches).toHaveLength(1);
        expect(launches[0][launches[0].indexOf(trust) - 1]).toBe('-c');
        await expect.poll(status).not.toEqual({ state: 'stopped' });
        await expect(running.page.locator('.commander-status-chip')).toContainText('Commander');
        await testInfo.attach('commander-after-server-restart', {
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

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander Terminal runs the shortcuts its context menu offers', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-shortcuts-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { startupOutput: 'Commander notes at https://example.com/commander' } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        const pane = commander.locator('.terminal-pane');
        await expect(pane.locator('.xterm-rows')).toContainText('https://example.com/commander');
        const terminalInput = pane.locator('.xterm-helper-textarea');

        await terminalInput.press('Meta+Shift+O');
        const picker = commander.getByRole('dialog', { name: 'Open Detected Link' });
        await expect(
            picker.getByRole('option', {
                name: 'Open external link https://example.com/commander',
                exact: true,
            }),
        ).toBeVisible();
        await testInfo.attach('commander-shortcut-detected-links', {
            body: await commander.screenshot(),
            contentType: 'image/png',
        });
        await commander.keyboard.press('Escape');
        await expect(picker).toBeHidden();

        await terminalInput.press('Meta+f');
        const search = commander.getByRole('textbox', { name: 'Find in Terminal', exact: true });
        await expect(search).toBeFocused();
        await testInfo.attach('commander-shortcut-find', {
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
 * A Commander that quits on `Ctrl+D`, as the Codex CLI does, which hands its Terminal back to the Shell underneath.
 */
const QUITTING_COMMANDER_SOURCE = `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0); }
if (process.argv[2] === 'app-server') process.exit(0);
process.stdout.write('Commander is running');
process.stdin.setRawMode?.(true);
process.stdin.on('data', (data) => {
  if (data.includes(4)) process.stdout.write(' Commander quit', () => process.exit(0));
});
`;

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander Terminal restarts from its shortcut after it exits', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-restart-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { executableSource: QUITTING_COMMANDER_SOURCE } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        const pane = commander.locator('.terminal-pane');
        const terminalInput = pane.locator('.xterm-helper-textarea');
        const commanderTerminal = async () => {
            const { identity, workbench } = await pageRequest<CommanderSnapshot>(
                running.page,
                'commander.snapshot',
            );
            return workbench.terminals.find(({ id }) => id === identity.terminalId);
        };
        await expect(pane.locator('.xterm-rows')).toContainText('Commander is running');
        const exitedProcessId = (await commanderTerminal())?.processId;

        await terminalInput.press('Control+d');
        // The Agent quits back to its Shell; typing before it is gone would feed the Agent instead.
        await expect(pane.locator('.xterm-rows')).toContainText('Commander quit');
        await terminalInput.pressSequentially('exit');
        await terminalInput.press('Enter');
        const stopped = commander.locator('[data-terminal-exit-state="stopped"]');
        await expect(stopped).toContainText('Process exited normally');

        await commander.keyboard.press('Meta+Shift+R');
        await expect(stopped).toHaveCount(0);
        await expect
            .poll(async () => {
                const terminal = await commanderTerminal();
                return (
                    terminal?.lastProcessState === 'running' &&
                    terminal.processId !== exitedProcessId
                );
            })
            .toBe(true);
        await testInfo.attach('commander-restarted-from-shortcut', {
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

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander Terminal inserts the path of a screenshot dropped from Finder', async ({}, testInfo) => {
    const directory = await realpath(await mkdtemp(`${tmpdir()}/caxri-commander-drop-e2e-`));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const screenshot = join(directory, 'Screenshot 2026-09-28 at 07.40.png');
    await writeFile(screenshot, 'fixture\n');
    const capture = join(directory, 'commander-input.txt');
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { inputCapture: { path: capture, encoding: 'utf8' } } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;
        const pane = commander.locator('.terminal-pane');
        await expect(pane.locator('.xterm-rows')).toContainText('Fake codex ready');

        await dropFinderFiles(commander, pane, [screenshot]);

        // The Commander works outside every Project, so the path stays absolute, quoted for its spaces.
        await expect
            .poll(() => readFileForPoll(() => readFile(capture, 'utf8')))
            .toBe(`'${screenshot}'\n`);
        await expect(pane.locator('.xterm-helper-textarea')).toBeFocused();
        await testInfo.attach('commander-finder-drop', {
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

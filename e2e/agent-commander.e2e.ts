import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

import type { AppSettings, CommanderSnapshot, CommanderStatus } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    waitForRuntimeReady,
} from './support/helpers.ts';

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
                window.webContents.getURL().includes('agent-commander'),
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
 * Server Core restart takes every PTY with it, and the Server restores only the selected Session, which is never the
 * Commander's. An open window must bring its Commander back itself instead of showing a Terminal nothing restarts.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander restarts under its open window after Server Core restarts', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-restart-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
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

/**
 * A synthetic Commander that creates one Session and delegates a task into it through the real CLI and its own Agent
 * Endpoint, recording only IDs and exit codes. The CLI path is passed in because the Commander workspace is outside the
 * checkout.
 */
function delegatingCommanderSource(cliPath: string, resultPath: string, taskPath: string): string {
    return `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0); }
if (process.argv[2] === 'app-server') process.exit(0);
process.stdin.setRawMode?.(true);
process.stdin.resume();
const cli = args => spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...args, '--json'], { encoding: 'utf8', env: process.env, timeout: 45000 });
const record = value => fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(value));
const board = cli(['commander', 'board']);
if (board.status !== 0) { record({ step: 'board', code: board.status }); return; }
const projectId = JSON.parse(board.stdout).rows[0]?.projectId;
const created = cli(['commander', 'session', 'create', '--project', projectId]);
if (created.status !== 0) { record({ step: 'session', code: created.status }); return; }
const { sessionId } = JSON.parse(created.stdout);
fs.writeFileSync(${JSON.stringify(taskPath)}, 'Synthetic task');
const delegated = cli(['agent', 'delegate', 'create', '--project', projectId, '--session', sessionId, '--prompt-file', ${JSON.stringify(taskPath)}, '--provider', 'grok']);
if (delegated.status !== 0) { record({ step: 'delegate', code: delegated.status }); return; }
record({ step: 'done', sessionId, delegationId: JSON.parse(delegated.stdout).delegationId });
`;
}

/**
 * A delegated Agent that starts and then sits silent, as a real one does at a folder-trust or sign-in prompt: its
 * process lives, but no lifecycle hook ever reports a session.
 */
const WAITING_AGENT_SOURCE = `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('grok 1.0.24'); process.exit(0); }
process.stdin.setRawMode?.(true);
process.stdin.resume();
`;

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander board moves a task stuck at Agent startup to Needs attention', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-board-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const resultPath = join(directory, 'result.json');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: delegatingCommanderSource(
                    join(import.meta.dirname, '..', 'apps/cli/dist/caxri.cjs'),
                    resultPath,
                    join(directory, 'task.md'),
                ),
            },
            grok: { executableSource: WAITING_AGENT_SOURCE },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });
    try {
        /**
         * A visible delegation launches only a provider whose lifecycle hooks are installed and enabled.
         */
        const settings = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        settings.value['agents.providers'].grok.hooks.enabled = true;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings.value),
        });
        await createShellSession(running.page);
        await pageRequest(running.page, 'agentCommander.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const commander = running.app.windows().find((page) => page !== running.page)!;

        const readResult = async () => {
            try {
                return JSON.parse(await readFile(resultPath, 'utf8')) as {
                    step: string;
                    sessionId?: string;
                };
            } catch {
                return;
            }
        };
        await expect.poll(readResult).toMatchObject({ step: 'done' });
        const { sessionId } = (await readResult())!;
        /**
         * The startup deadline (15 seconds) moves the task to `blocked`/`startup_waiting`. The board's 10-second poll
         * also picks that up, so this proves the attention path end to end, not the latency of the receipt event; the
         * event itself is covered by the delegation service tests.
         */
        const task = commander.locator(
            `li[data-session-id="${sessionId}"][data-commander-group="attention"] .commander-board-task`,
        );
        await expect(task).toHaveText('Needs you', { timeout: 45_000 });
        await testInfo.attach('commander-board-needs-you', {
            body: await commander.locator('.commander-board').screenshot(),
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

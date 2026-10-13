import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { connectToServer, discoverServerManifest } from '@caxri/client/supervise';
import {
    observationProcessManifestDirectory,
    observationProcessOwners,
    readObservationProcessManifests,
} from '@caxri/system';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { runningWork } from './support/running-work.ts';

const QUIT_DIALOG_PROBE_KEY = '__caxriE2EQuitDialogProbe';
const QUIT_BUTTONS = ['Quit and Stop Tasks', 'Quit and Keep Tasks Running', 'Cancel'];
const QUIT_DETAIL =
    'Quit and Stop Tasks ends every running Terminal and Agent process, releases Agent conversations so they can be resumed in other tools, and stops Caxri Server. Quit and Keep Tasks Running leaves them attached to Caxri in the background.';

interface QuitDialogSnapshot {
    buttons: string[];
    cancelId?: number;
    defaultId?: number;
    detail?: string;
    message: string;
    title?: string;
    type?: string;
}

type OwnedProcessPids = Record<(typeof observationProcessOwners)[number], number>;

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function codexLifecycleFixture(pidPath: string): string {
    return String.raw`#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid), 'utf8');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('QUIT_LIFECYCLE_AGENT_READY\r\n');
`;
}

async function installQuitDialogProbe(app: E2EApp): Promise<void> {
    await app.evaluate(({ dialog }, key) => {
        Reflect.deleteProperty(globalThis, key);
        dialog.showMessageBox = (windowOrOptions: unknown, maybeOptions?: MessageBoxOptions) => {
            const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
            return new Promise<MessageBoxReturnValue>((resolve) => {
                Reflect.set(globalThis, key, {
                    options,
                    respond: (response: number) => resolve({ response, checkboxChecked: false }),
                });
            });
        };
    }, QUIT_DIALOG_PROBE_KEY);
}

async function readQuitDialog(app: E2EApp): Promise<QuitDialogSnapshot | null> {
    return app.evaluate((_electron, key) => {
        const probe = Reflect.get(globalThis, key) as { options: MessageBoxOptions } | undefined;
        if (!probe) return null;
        const { options } = probe;
        return {
            buttons: [...(options.buttons ?? [])],
            cancelId: options.cancelId,
            defaultId: options.defaultId,
            detail: options.detail,
            message: options.message,
            title: options.title,
            type: options.type,
        };
    }, QUIT_DIALOG_PROBE_KEY);
}

async function waitForQuitDialog(app: E2EApp): Promise<QuitDialogSnapshot> {
    await expect.poll(() => readQuitDialog(app)).not.toBeNull();
    const snapshot = await readQuitDialog(app);
    if (!snapshot) throw new Error('Quit dialog probe disappeared before it was answered');
    return snapshot;
}

async function answerQuitDialog(app: E2EApp, response: number): Promise<void> {
    await app.evaluate(
        (_electron, input) => {
            const probe = Reflect.get(globalThis, input.key) as
                { respond(response: number): void } | undefined;
            if (!probe) throw new Error('Quit dialog was not pending');
            Reflect.deleteProperty(globalThis, input.key);
            /**
             * Let Playwright receive this evaluation result before an accepted answer closes Electron's Main context.
             */
            setImmediate(() => probe.respond(input.response));
        },
        { key: QUIT_DIALOG_PROBE_KEY, response },
    );
}

async function requestQuit(app: E2EApp): Promise<void> {
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
}

async function settleMainTurn(app: E2EApp): Promise<void> {
    await app.evaluate(() => new Promise<void>((resolve) => setImmediate(resolve)));
}

async function waitForAgentPid(path: string): Promise<number> {
    let processId: number | undefined;
    await expect
        .poll(async () => {
            let source: string;
            try {
                source = await readFile(path, 'utf8');
            } catch (error) {
                if (errorCode(error) === 'ENOENT') return 'pending';
                throw error;
            }
            const candidate = Number(source);
            if (!Number.isSafeInteger(candidate) || candidate <= 0)
                throw new Error('Fake Codex published an invalid process id');
            processId = candidate;
            return 'ready';
        })
        .toBe('ready');
    return processId!;
}

async function waitForOwnedProcesses(userDataDirectory: string): Promise<OwnedProcessPids> {
    let processIds: OwnedProcessPids | undefined;
    await expect
        .poll(async () => {
            const manifests = await readObservationProcessManifests(
                observationProcessManifestDirectory(userDataDirectory),
            );
            if (
                observationProcessOwners.some(
                    (owner) => manifests[owner]?.state !== 'ready' || !manifests[owner]?.pid,
                )
            )
                return 'pending';
            processIds = Object.fromEntries(
                observationProcessOwners.map((owner) => [owner, manifests[owner]!.pid]),
            ) as OwnedProcessPids;
            return 'ready';
        })
        .toBe('ready');
    return processIds!;
}

async function expectOwnedProcessState(
    userDataDirectory: string,
    processIds: OwnedProcessPids,
    state: 'ready' | 'stopped',
): Promise<void> {
    await expect
        .poll(async () => {
            const manifests = await readObservationProcessManifests(
                observationProcessManifestDirectory(userDataDirectory),
            );
            return observationProcessOwners.map((owner) => ({
                owner,
                pid: manifests[owner]?.pid,
                state: manifests[owner]?.state,
            }));
        })
        .toEqual(
            observationProcessOwners.map((owner) => ({
                owner,
                pid: processIds[owner],
                state,
            })),
        );
}

async function expectProcessLiveness(
    processIds: number[],
    isExpectedAlive: boolean,
): Promise<void> {
    const uniqueProcessIds = [...new Set(processIds)];
    await expect
        .poll(() => uniqueProcessIds.map((processId) => isProcessAlive(processId)))
        .toEqual(uniqueProcessIds.map(() => isExpectedAlive));
}

async function isHostManifestPresent(userDataDirectory: string): Promise<boolean> {
    try {
        await discoverServerManifest(userDataDirectory);
        return true;
    } catch (error) {
        if (errorCode(error) === 'NOT_FOUND') return false;
        throw error;
    }
}

async function stopHostForCleanup(userDataDirectory: string): Promise<void> {
    let client: Awaited<ReturnType<typeof connectToServer>> | undefined;
    try {
        client = await connectToServer(userDataDirectory, 2_000);
        await client.request('host.stop', { confirmLivePtys: true });
    } catch (error) {
        if (!['NOT_FOUND', 'UNAVAILABLE'].includes(errorCode(error) ?? '')) throw error;
    } finally {
        client?.close();
    }
    await expect.poll(() => isHostManifestPresent(userDataDirectory)).toBe(false);
}

async function closeAppForCleanup(app: E2EApp | undefined): Promise<void> {
    if (!app) return;
    try {
        if (await readQuitDialog(app)) {
            await answerQuitDialog(app, 1);
        } else {
            await app.evaluate(({ dialog }) => {
                dialog.showMessageBox = () =>
                    Promise.resolve({ response: 1, checkboxChecked: false });
            });
        }
    } catch {
        // The application may already be closed.
    }
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

test('quit can cancel, keep one live Agent for reconnection, or stop its complete process tree', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-desktop-quit-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const agentPidPath = join(testDirectory, 'agent.pid');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: { executableSource: codexLifecycleFixture(agentPidPath) },
        },
    });
    const launchOptions = {
        agentMode,
        preserveHostOnClose: true,
        testRootPath: root,
        userDataDir: userData,
    } as const;
    let first: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    let second: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    let observer: Awaited<ReturnType<typeof connectToServer>> | undefined;

    try {
        first = await launchCaxri(launchOptions);
        const sessionId = await createProjectSession(first.page, 'codex');
        await expect(first.page.locator('.xterm-rows')).toContainText('QUIT_LIFECYCLE_AGENT_READY');
        const bootstrap = await pageRequest<{
            terminals: Array<{ id: string; processId?: number; sessionId: string }>;
        }>(first.page, 'app.bootstrap');
        const terminal = bootstrap.terminals.find((candidate) => candidate.sessionId === sessionId);
        if (!terminal?.processId)
            throw new Error('Live Agent Terminal did not publish a process id');
        const terminalId = terminal.id;
        const terminalProcessId = terminal.processId;
        const agentProcessId = await waitForAgentPid(agentPidPath);
        const hostBefore = await pageRequest<{
            activePtyCount: number;
            clientCount: number;
            pid: number;
        }>(first.page, 'host.status');
        expect(hostBefore).toMatchObject({ activePtyCount: 1, clientCount: 1 });
        const ownedProcessIds = await waitForOwnedProcesses(userData);
        expect(ownedProcessIds['server-core']).toBe(hostBefore.pid);
        const completeProcessTree = [
            ...Object.values(ownedProcessIds),
            terminalProcessId,
            agentProcessId,
        ];
        await expectProcessLiveness(completeProcessTree, true);

        await installQuitDialogProbe(first.app);
        await requestQuit(first.app);
        expect(await waitForQuitDialog(first.app)).toEqual({
            buttons: QUIT_BUTTONS,
            cancelId: 2,
            defaultId: 1,
            detail: QUIT_DETAIL,
            message: 'Quit Caxri while 1 Terminal is running?',
            title: 'Quit Caxri?',
            type: 'warning',
        });
        await answerQuitDialog(first.app, 2);
        await settleMainTurn(first.app);

        await expect.poll(() => first!.page.isClosed()).toBe(false);
        await expect(
            pageRequest<{ ready: boolean }>(first.page, 'app.health'),
        ).resolves.toMatchObject({ ready: true });
        await expect.poll(() => runningWork(first!.page)).toEqual({ terminals: 1, chats: 0 });
        await expectProcessLiveness(completeProcessTree, true);

        await installQuitDialogProbe(first.app);
        await requestQuit(first.app);
        expect(await waitForQuitDialog(first.app)).toMatchObject({
            buttons: QUIT_BUTTONS,
            cancelId: 2,
            defaultId: 1,
        });
        const firstClosed = first.app.waitForEvent('close');
        await answerQuitDialog(first.app, 1);
        await firstClosed;
        await first.app.close();

        await expectProcessLiveness(completeProcessTree, true);
        await expectOwnedProcessState(userData, ownedProcessIds, 'ready');
        observer = await connectToServer(userData, 2_000);
        await expect
            .poll(async () => {
                const status = await observer!.request('host.status');
                return {
                    activePtyCount: status.activePtyCount,
                    clientCount: status.clientCount,
                    desktop: status.desktop.state,
                    pid: status.pid,
                };
            })
            .toEqual({
                activePtyCount: 1,
                clientCount: 1,
                desktop: 'offline',
                pid: hostBefore.pid,
            });

        second = await launchCaxri(launchOptions);
        await expect(second.page.locator('.xterm-rows')).toContainText(
            'QUIT_LIFECYCLE_AGENT_READY',
        );
        const reconnected = await pageRequest<{
            terminals: Array<{ id: string; processId?: number }>;
        }>(second.page, 'app.bootstrap');
        expect(
            reconnected.terminals.find((candidate) => candidate.id === terminalId)?.processId,
        ).toBe(terminalProcessId);
        const hostAfterReconnect = await pageRequest<{
            activePtyCount: number;
            clientCount: number;
            pid: number;
        }>(second.page, 'host.status');
        expect(hostAfterReconnect).toEqual(
            expect.objectContaining({ activePtyCount: 1, clientCount: 2, pid: hostBefore.pid }),
        );
        await expectProcessLiveness(completeProcessTree, true);

        await installQuitDialogProbe(second.app);
        await requestQuit(second.app);
        expect(await waitForQuitDialog(second.app)).toEqual({
            buttons: QUIT_BUTTONS,
            cancelId: 2,
            defaultId: 1,
            detail:
                `${QUIT_DETAIL}\n\n1 other client is connected to Caxri Server. ` +
                'Stopping will disconnect it.',
            message: 'Quit Caxri while 1 Terminal is running?',
            title: 'Quit Caxri?',
            type: 'warning',
        });
        const secondClosed = second.app.waitForEvent('close');
        await answerQuitDialog(second.app, 0);
        await secondClosed;
        await second.app.close();

        await expectProcessLiveness(completeProcessTree, false);
        await expectOwnedProcessState(userData, ownedProcessIds, 'stopped');
        await expect.poll(() => isHostManifestPresent(userData)).toBe(false);
    } finally {
        observer?.close();
        await closeAppForCleanup(second?.app);
        await closeAppForCleanup(first?.app);
        await stopHostForCleanup(userData);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

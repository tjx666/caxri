import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
    connectDesktopToServer,
    connectToServer,
    discoverServerManifest,
} from '@caxri/client/supervise';

import { runRunnerCli } from './support/cli-environment.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    typeTerminal,
    waitForRuntimeReady,
} from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const cliPath = join(projectRoot, 'apps', 'cli', 'dist', 'caxri.cjs');
const electronPath = join(
    projectRoot,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron',
);

function runCli(arguments_: readonly string[]) {
    return runRunnerCli(cliPath, arguments_);
}

test('routes bounded Desktop open, focus, and reveal operations through the existing Host', async () => {
    allowE2EErrors([
        { source: 'server-core', event: 'ipc.request_failed', code: 'PATH_DENIED', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-desktop-host-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const outside = join(testDirectory, 'outside');
    const file = join(root, 'desktop-open.ts');
    const reopenedFile = join(root, 'desktop-reopen.ts');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(outside, { recursive: true })]);
    await Promise.all([
        writeFile(file, 'export const desktopOpen = true;\n', 'utf8'),
        writeFile(reopenedFile, 'export const desktopReopen = true;\n', 'utf8'),
        writeFile(join(outside, 'secret.ts'), 'outside\n', 'utf8'),
        symlink(join(outside, 'secret.ts'), join(root, 'escape.ts')),
    ]);
    const canonicalFile = await realpath(file);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
    });
    const client = await connectToServer(userData, 2_000);
    try {
        await createShellSession(running.page);
        const bootstrap = await pageRequest<{
            selectedSessionId?: string;
            sessions: Array<{ id: string }>;
        }>(running.page, 'app.bootstrap');
        const sessionId = bootstrap.selectedSessionId!;
        const status = await client.request('host.status');
        expect(status).toMatchObject({
            desktop: { state: 'window' },
            pid: expect.any(Number),
        });

        const openFile = await runCli([
            'open',
            file,
            '--session',
            sessionId,
            '--no-launch',
            '--profile',
            userData,
            '--request-id',
            'desktop-open-file-e2e',
            '--yes',
            '--json',
        ]);
        expect(openFile).toMatchObject({ code: 0, stderr: '' });
        expect(JSON.parse(openFile.stdout)).toMatchObject({ state: 'requested', sessionId });
        await expect(
            running.page.locator('.work-tab', { hasText: 'desktop-open.ts' }),
        ).toBeVisible();
        const openProject = await runCli([
            'open',
            root,
            '--session',
            sessionId,
            '--no-launch',
            '--profile',
            userData,
            '--request-id',
            'desktop-open-project-e2e',
            '--yes',
            '--json',
        ]);
        expect(openProject).toMatchObject({ code: 0, stderr: '' });
        expect(JSON.parse(openProject.stdout)).toMatchObject({ state: 'requested', sessionId });
        await expect(
            client.request('desktop.openFile', {
                path: join(testDirectory, 'outside', 'secret.ts'),
                launchIfNeeded: false,
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            client.request('desktop.openFile', {
                path: join(root, 'escape.ts'),
                launchIfNeeded: false,
            }),
        ).resolves.toMatchObject({ state: 'requested' });

        await running.app.evaluate(({ shell }) => {
            shell.showItemInFolder = (path) => {
                Reflect.set(globalThis, '__caxriRevealedPath', path);
            };
        });
        const reveal = await runCli([
            'reveal',
            file,
            '--session',
            sessionId,
            '--profile',
            userData,
            '--request-id',
            'desktop-reveal-e2e',
            '--yes',
            '--json',
        ]);
        expect(reveal).toMatchObject({ code: 0, stderr: '' });
        expect(JSON.parse(reveal.stdout)).toMatchObject({ state: 'revealed', sessionId });
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const value: unknown = Reflect.get(globalThis, '__caxriRevealedPath');
                    return typeof value === 'string' ? value : undefined;
                }),
            )
            .toBe(canonicalFile);

        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        const closed = running.page.waitForEvent('close');
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
        );
        await closed;
        await expect(client.request('desktop.status')).resolves.toMatchObject({
            state: 'background',
        });
        const reopened = running.app.waitForEvent('window');
        await expect(
            client.request('desktop.openFile', { path: reopenedFile, launchIfNeeded: false }),
        ).resolves.toMatchObject({ state: 'requested', sessionId });
        const reopenedPage = await reopened;
        await waitForRuntimeReady(reopenedPage);
        await expect(
            reopenedPage.locator('.work-tab', { hasText: 'desktop-reopen.ts' }),
        ).toBeVisible();
        await expect(
            reopenedPage.locator('.monaco-editor[data-uri*="desktop-reopen.ts"]'),
        ).toContainText('desktopReopen');
    } finally {
        client.close();
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('queues concurrent Host open requests by their exact Session targets', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-desktop-open-queue-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const firstFile = join(root, 'first-session.ts');
    const secondFile = join(root, 'second-session.ts');
    await mkdir(root, { recursive: true });
    await Promise.all([
        writeFile(firstFile, 'export const firstSession = true;\n', 'utf8'),
        writeFile(secondFile, 'export const secondSession = true;\n', 'utf8'),
    ]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const client = await connectToServer(userData, 2_000);
    try {
        await createShellSession(running.page);
        const initial = await pageRequest<{
            selectedSessionId?: string;
            sessions: Array<{ id: string; projectId: string }>;
        }>(running.page, 'app.bootstrap');
        const firstSessionId = initial.selectedSessionId;
        if (!firstSessionId) throw new Error('Expected the first Session to be selected');
        const firstSession = initial.sessions.find(({ id }) => id === firstSessionId);
        if (!firstSession) throw new Error('Expected the selected Session record');
        const second = await pageRequest<{ session: { id: string } }>(
            running.page,
            'session.create',
            {
                projectId: firstSession.projectId,
                defaultAgent: 'shell',
            },
        );

        const [first, secondOpen] = await Promise.all([
            client.request('desktop.openFile', {
                path: firstFile,
                sessionId: firstSessionId,
                launchIfNeeded: false,
            }),
            client.request('desktop.openFile', {
                path: secondFile,
                sessionId: second.session.id,
                launchIfNeeded: false,
            }),
        ]);

        /**
         * The Host has routed the request; Renderer work remains asynchronous and ordered below.
         */
        expect(first).toMatchObject({ state: 'requested', sessionId: firstSessionId });
        expect(secondOpen).toMatchObject({ state: 'requested', sessionId: second.session.id });
        await pageRequest(running.page, 'session.select', { sessionId: second.session.id });
        await expect.poll(() => selectedSessionId(running.page)).toBe(second.session.id);
        await expect(
            running.page.locator('.work-tab', { hasText: 'second-session.ts' }),
        ).toBeVisible();
        await pageRequest(running.page, 'session.select', { sessionId: firstSessionId });
        await expect.poll(() => selectedSessionId(running.page)).toBe(firstSessionId);
        await expect(
            running.page.locator('.work-tab', { hasText: 'first-session.ts' }),
        ).toBeVisible();
    } finally {
        client.close();
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('keeps one focused Desktop and one process profile for a repeated same-profile launch', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-profile-instance-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
    });
    const client = await connectToServer(userData, 2_000);
    try {
        const before = await client.request('host.status');
        await running.app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0]?.minimize();
        });
        await expect
            .poll(() =>
                running.app.evaluate(
                    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false,
                ),
            )
            .toBe(true);

        const second = spawn(electronPath, ['apps/desktop', '--disable-gpu'], {
            cwd: projectRoot,
            env: {
                ...process.env,
                CAXRI_E2E: '1',
                CAXRI_E2E_AGENT_MODE: 'blocked',
                CAXRI_E2E_WINDOW_MODE: 'visible',
                CAXRI_TEST_ROOT_PATH: root,
                CAXRI_USER_DATA_DIR: userData,
            },
            stdio: 'ignore',
        });
        const [code, signal] = (await once(second, 'exit', {
            signal: AbortSignal.timeout(5_000),
        })) as [number | null, NodeJS.Signals | null];
        expect({ code, signal }).toEqual({ code: 0, signal: null });

        await expect
            .poll(() =>
                running.app.evaluate(({ BrowserWindow }) => {
                    const window = BrowserWindow.getAllWindows()[0];
                    return { minimized: window.isMinimized(), visible: window.isVisible() };
                }),
            )
            .toEqual({ minimized: false, visible: true });
        await expect(
            running.page.getByText(
                'Another Caxri window took over this profile. Continue in the other window.',
                { exact: true },
            ),
        ).toHaveCount(0);

        const after = await client.request('host.status');
        expect(after).toMatchObject({ pid: before.pid });
        const manifest = await discoverServerManifest(userData);
        expect(manifest.profileId).toBe(after.profileId);
        await Promise.all(
            ['caxri.db', 'logs/desktop.jsonl', 'logs/server-core.jsonl'].map((path) =>
                access(join(userData, path)),
            ),
        );
        const appReady = (await readFile(join(userData, 'logs', 'desktop.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event?: string; fields?: Record<string, unknown> })
            .find(({ event }) => event === 'app.ready');
        expect(appReady?.fields).toMatchObject({
            profileId: manifest.profileId,
            profileKind: 'explicit',
            remoteDebuggingPort: '0',
            remoteDebuggingTransport: 'port',
        });
        await expect
            .poll(async () =>
                (await readFile(join(userData, 'logs', 'desktop.jsonl'), 'utf8')).includes(
                    '"event":"app.second_instance_focused"',
                ),
            )
            .toBe(true);
    } finally {
        client.close();
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('stops reconnecting when another Desktop takes over the same profile', async () => {
    // The takeover asserted below is announced to the replaced window as one notification.
    allowE2EErrors([{ source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 }]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-desktop-replaced-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    let replacement: Awaited<ReturnType<typeof connectDesktopToServer>> | undefined;
    try {
        replacement = await connectDesktopToServer(
            userData,
            'desktop-replacement-e2e',
            () => Promise.resolve(null),
            2_000,
        );
        await replacement.markDesktopReady();

        await expect(
            running.page.getByText(
                'Another Caxri window took over this profile. Continue in the other window.',
                { exact: true },
            ),
        ).toBeVisible();
        const replacementStartedAt = Date.now();
        await expect
            .poll(
                async () => {
                    const health = await replacement?.request('app.health');
                    return health?.ready && Date.now() - replacementStartedAt >= 1_100;
                },
                { intervals: [100, 200, 300, 500], timeout: 2_000 },
            )
            .toBe(true);
    } finally {
        replacement?.close();
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('recovers requests, events, and Desktop commands after the Server Core is killed', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-host-relaunch-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
    });
    let recoveredClient: Awaited<ReturnType<typeof connectToServer>> | undefined;
    try {
        const selectedRoot = await pageRequest<string | null>(
            running.page,
            'dialog.selectDirectory',
        );
        expect(selectedRoot).toBe(root);
        if (!selectedRoot) throw new Error('Expected the test folder selection to succeed');
        const project = await pageRequest<{ id: string }>(running.page, 'project.create', {
            rootPath: selectedRoot,
        });
        await running.page.evaluate(() => {
            const target = globalThis as unknown as {
                __caxriRecoveredStateChanges?: string[];
                caxri: {
                    onEvent(listener: (event: unknown) => void): () => void;
                };
            };
            target.__caxriRecoveredStateChanges = [];
            target.caxri.onEvent((event) => {
                const candidate = event as {
                    event?: string;
                    payload?: { reason?: string };
                };
                if (candidate.event === 'state.changed' && candidate.payload?.reason) {
                    target.__caxriRecoveredStateChanges?.push(candidate.payload.reason);
                }
            });
        });

        const before = await pageRequest<{ pid: number }>(running.page, 'host.status');
        process.kill(before.pid, 'SIGKILL');
        await expect
            .poll(() => {
                try {
                    process.kill(before.pid, 0);
                    return true;
                } catch {
                    return false;
                }
            })
            .toBe(false);

        let after: { pid: number } | undefined;
        await expect
            .poll(async () => {
                let candidate: Awaited<ReturnType<typeof connectToServer>> | undefined;
                try {
                    candidate = await connectToServer(userData, 2_000);
                    after = await candidate.request('host.status');
                    if (after.pid === before.pid) return before.pid;
                    recoveredClient?.close();
                    recoveredClient = candidate;
                    candidate = undefined;
                    return after.pid;
                } catch {
                    return before.pid;
                } finally {
                    candidate?.close();
                }
            })
            .not.toBe(before.pid);
        expect(after).toMatchObject({ pid: expect.any(Number) });
        if (!recoveredClient) throw new Error('Expected the relaunched Host client to connect');
        const recoveredHost = recoveredClient;

        await expect
            .poll(async () => (await recoveredHost.request('desktop.status')).state)
            .toBe('window');
        await expect(
            pageRequest<{ ready: boolean }>(running.page, 'app.health'),
        ).resolves.toMatchObject({ ready: true });

        const created = await pageRequest<{ session: { id: string } }>(
            running.page,
            'session.create',
            { projectId: project.id, defaultAgent: 'shell' },
        );
        await expect
            .poll(() =>
                running.page.evaluate(() => {
                    const target = globalThis as unknown as {
                        __caxriRecoveredStateChanges?: string[];
                    };
                    return target.__caxriRecoveredStateChanges ?? [];
                }),
            )
            .toContain('session.create');
        await expect(
            running.page.locator(`.session-card[data-session-id="${created.session.id}"]`),
        ).toBeVisible();

        await expect(
            recoveredHost.request('desktop.focus', { launchIfNeeded: false }),
        ).resolves.toMatchObject({ state: 'focused', generation: expect.any(Number) });
    } finally {
        recoveredClient?.close();
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('reconnects a new Desktop generation to the same live PTY', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-desktop-reconnect-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const first = await launchCaxri({
        preserveHostOnClose: true,
        userDataDir: userData,
        testRootPath: root,
    });
    let second: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    const client = await connectToServer(userData, 2_000);
    try {
        await createShellSession(first.page);
        const before = await pageRequest<{
            terminals: Array<{ id: string; processId?: number }>;
        }>(first.page, 'app.bootstrap');
        await typeTerminal(
            first.page,
            String.raw`printf 'BEFORE_RECONNECT\n'; sleep 1; printf 'AFTER_RECONNECT\n'`,
        );
        await expect(first.page.locator('.xterm-rows')).toContainText('BEFORE_RECONNECT');
        const hostBefore = await client.request('host.status');
        await first.app.close();
        await expect
            .poll(async () => {
                try {
                    const status = await client.request('desktop.status');
                    return status.state;
                } catch {
                    return 'disconnecting';
                }
            })
            .toBe('offline');
        await new Promise((resolve) => setTimeout(resolve, 1_100));

        second = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await expect(second.page.locator('.xterm-rows')).toContainText('AFTER_RECONNECT');
        const after = await pageRequest<{
            terminals: Array<{ id: string; processId?: number }>;
        }>(second.page, 'app.bootstrap');
        const hostAfter = await client.request('host.status');
        expect(after.terminals).toEqual(before.terminals);
        expect(hostAfter.pid).toBe(hostBefore.pid);
        expect(hostAfter.desktop).toMatchObject({ state: 'window' });
    } finally {
        client.close();
        try {
            await first.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        try {
            await second?.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        if (!second) {
            let cleanup: Awaited<ReturnType<typeof connectToServer>> | undefined;
            try {
                cleanup = await connectToServer(userData, 2_000);
            } catch {
                // The Host may already be offline; nothing left to stop.
            }
            try {
                await cleanup?.request('host.stop', { confirmLivePtys: true });
            } catch {
                // Ignore host-stop errors during test cleanup.
            }
            cleanup?.close();
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

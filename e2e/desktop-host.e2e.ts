import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectToHost } from '@caxri/cli';

import { allowE2EErrors, expect, test } from './fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    typeTerminal,
    waitForRuntimeReady,
} from './helpers.ts';

test('routes bounded Desktop open, focus, and reveal operations through the existing Host', async () => {
    allowE2EErrors([
        { source: 'runtime', event: 'ipc.request_failed', code: 'PATH_DENIED', count: 2 },
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
    const client = await connectToHost(userData, 2_000);
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
            runtimePid: expect.any(Number),
        });

        await expect(
            client.request('desktop.openFile', { path: file, launchIfNeeded: false }),
        ).resolves.toMatchObject({ state: 'opened', sessionId });
        await expect(
            running.page.locator('.work-tab', { hasText: 'desktop-open.ts' }),
        ).toBeVisible();
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
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });

        await running.app.evaluate(({ shell }) => {
            shell.showItemInFolder = (path) => {
                Reflect.set(globalThis, '__caxriRevealedPath', path);
            };
        });
        await expect(
            client.request('files.reveal', { path: file, sessionId, launchIfNeeded: false }),
        ).resolves.toMatchObject({ state: 'revealed', sessionId });
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
        ).resolves.toMatchObject({ state: 'opened', sessionId });
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
        await running.app.close().catch(() => undefined);
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
    const client = await connectToHost(userData, 2_000);
    try {
        await createShellSession(first.page);
        const before = await pageRequest<{
            terminals: Array<{ id: string; processId?: number }>;
        }>(first.page, 'app.bootstrap');
        await typeTerminal(
            first.page,
            "printf 'BEFORE_RECONNECT\\n'; sleep 1; printf 'AFTER_RECONNECT\\n'",
        );
        await expect(first.page.locator('.xterm-rows')).toContainText('BEFORE_RECONNECT');
        const hostBefore = await client.request('host.status');
        await first.app.close();
        await expect
            .poll(() =>
                client
                    .request('desktop.status')
                    .then((status) => status.state)
                    .catch(() => 'disconnecting'),
            )
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
        expect(hostAfter.runtimePid).toBe(hostBefore.runtimePid);
        expect(hostAfter.desktop).toMatchObject({ state: 'window' });
    } finally {
        client.close();
        await first.app.close().catch(() => undefined);
        await second?.app.close().catch(() => undefined);
        if (!second) {
            const cleanup = await connectToHost(userData, 2_000).catch(() => undefined);
            await cleanup?.request('host.stop', { confirmLivePtys: true }).catch(() => undefined);
            cleanup?.close();
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ElectronApplication as ElectronApp, Page } from './support/fixtures.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

const execFileAsync = promisify(execFile);

interface RunningCaxri {
    app: ElectronApp;
    page: Page;
}

async function openProcessExplorer(running: RunningCaxri): Promise<Page> {
    const action = running.page.getByRole('button', {
        name: /^Open Process Explorer — Terminal memory: [\d.]+ MB$/,
    });
    await action.click();
    await expect.poll(() => running.app.windows().length).toBe(2);
    return running.app.windows().find((page) => page !== running.page)!;
}

async function processExplorerWindowId(app: ElectronApp): Promise<number> {
    return app.evaluate(({ BrowserWindow }) => {
        const processExplorer = BrowserWindow.getAllWindows().find(
            (window) => window.getTitle() === 'Process Explorer — Caxri',
        );
        if (!processExplorer) throw new Error('Process Explorer window was not found');
        return processExplorer.id;
    });
}

async function forceProcessExplorerCrash(app: ElectronApp, windowId: number): Promise<void> {
    await app.evaluate(({ BrowserWindow }, id) => {
        const processExplorer = BrowserWindow.fromId(id);
        if (!processExplorer) throw new Error('Process Explorer window was not found');
        processExplorer.webContents.forcefullyCrashRenderer();
    }, windowId);
}

async function waitForReadyProcessExplorer(app: ElectronApp, windowId: number): Promise<void> {
    await expect
        .poll(
            () =>
                app.evaluate(async ({ BrowserWindow }, id) => {
                    const processExplorer = BrowserWindow.fromId(id);
                    if (!processExplorer) return { exists: false, ready: false };
                    const isCrashed = processExplorer.webContents.isCrashed();
                    const status = {
                        exists: true,
                        crashed: isCrashed,
                        loading: processExplorer.webContents.isLoading(),
                        ready: false,
                        url: processExplorer.webContents.getURL(),
                    };
                    if (isCrashed) return status;
                    try {
                        status.ready = Boolean(
                            await processExplorer.webContents.executeJavaScript(
                                "Boolean(document.querySelector('[role=treegrid]'))",
                            ),
                        );
                    } catch {
                        return status;
                    }
                    return status;
                }, windowId),
            { timeout: 8_000 },
        )
        .toMatchObject({ exists: true, crashed: false, ready: true });
}

async function countLogEvents(logPath: string, event: string): Promise<number> {
    const contents = await readFile(logPath, 'utf8');
    return contents
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string })
        .filter((record) => record.event === event).length;
}

test('Process Explorer render exceptions offer a working reload', async () => {
    allowE2EErrors([
        {
            source: 'main',
            event: 'process_explorer.console_error',
            code: 'CONSOLE_ERROR',
            count: 3,
        },
        {
            source: 'main',
            event: 'process_explorer.page_exception',
            code: 'PAGE_EXCEPTION',
            count: 1,
        },
        { source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 2 },
        { source: 'renderer', event: 'pageerror', code: 'PAGE_ERROR', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-process-explorer-boundary-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_TEST_PROCESS_EXPLORER_RENDER_ERROR: '1' },
    });
    try {
        await createShellSession(running.page);
        const processPage = await openProcessExplorer(running);

        await expect(
            processPage.getByRole('heading', { name: 'Process Explorer stopped rendering' }),
        ).toBeVisible();
        await processPage.getByRole('button', { name: 'Reload Process Explorer' }).click();
        await expect(
            processPage.getByText('Process Explorer — Caxri', { exact: true }),
        ).toBeVisible();
        await processPage.evaluate(() => {
            setTimeout(() => {
                throw new Error('CAXRI_EXPECTED_PROCESS_EXPLORER_PAGE_EXCEPTION');
            }, 0);
        });
        await expect
            .poll(() =>
                countLogEvents(
                    join(userData, 'logs', 'main.jsonl'),
                    'process_explorer.page_exception',
                ),
            )
            .toBe(1);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Process Explorer bounds renderer crash recovery and reopens cleanly', async () => {
    allowE2EErrors([
        {
            source: 'main',
            event: 'process_explorer.console_error',
            code: 'CONSOLE_ERROR',
            count: 6,
        },
        {
            source: 'main',
            event: 'process_explorer.render_process_gone',
            code: 'RENDER_PROCESS_GONE',
            count: 3,
        },
        {
            source: 'main',
            event: 'process_explorer.render_process_crash_loop',
            code: 'RENDER_PROCESS_CRASH_LOOP',
            count: 1,
        },
        { source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 6 },
    ]);
    test.setTimeout(45_000);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-process-explorer-crash-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const mainLogPath = join(userData, 'logs', 'main.jsonl');
    try {
        await createShellSession(running.page);
        await openProcessExplorer(running);
        const windowId = await processExplorerWindowId(running.app);
        await waitForReadyProcessExplorer(running.app, windowId);

        for (let crashCount = 1; crashCount <= 3; crashCount += 1) {
            // Each iteration must crash and fully recover the same window before the next crash is
            // forced, so the iterations are intentionally sequential.
            // eslint-disable-next-line no-await-in-loop
            await forceProcessExplorerCrash(running.app, windowId);
            // eslint-disable-next-line no-await-in-loop
            await expect
                .poll(() => countLogEvents(mainLogPath, 'process_explorer.render_process_gone'))
                .toBe(crashCount);
            // eslint-disable-next-line no-await-in-loop
            await waitForReadyProcessExplorer(running.app, windowId);
        }

        await forceProcessExplorerCrash(running.app, windowId);
        await expect
            .poll(() => countLogEvents(mainLogPath, 'process_explorer.render_process_crash_loop'))
            .toBe(1);
        await expect.poll(() => running.app.windows().length).toBe(1);

        const processPage = await openProcessExplorer(running);
        await expect(
            processPage.getByText('Process Explorer — Caxri', { exact: true }),
        ).toBeVisible();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

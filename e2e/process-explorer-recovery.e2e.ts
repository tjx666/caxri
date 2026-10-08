import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import type { E2EApp as ElectronApp } from './support/electron-app.ts';
import type { Page } from './support/fixtures.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri } from './support/helpers.ts';

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
            source: 'desktop',
            event: 'process_explorer.console_error',
            code: 'CONSOLE_ERROR',
            count: 3,
        },
        {
            source: 'desktop',
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
        clipboard: true,
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
        const disclosure = processPage.locator('.renderer-crash-screen details');
        const stack = disclosure.locator('.renderer-crash-stack');
        await expect(disclosure).not.toHaveAttribute('open');
        await expect(stack).not.toBeVisible();
        await processPage.screenshot({
            path: test.info().outputPath('crash-details-collapsed.png'),
        });
        await processPage.getByText('Technical details', { exact: true }).click();
        await expect(stack).toBeVisible();
        const details = await stack.textContent();
        expect(details).toContain('Forced Process Explorer render error');
        const stackBounds = await stack.boundingBox();
        if (!stackBounds) throw new Error('Expanded crash details have no bounds');
        await processPage.screenshot({
            path: test.info().outputPath('crash-details-expanded.png'),
            clip: {
                x: stackBounds.x,
                y: stackBounds.y - 38,
                width: stackBounds.width,
                height: 62,
            },
        });
        await processPage.getByRole('button', { name: 'Copy details' }).click();
        await expect.poll(() => running.clipboard.textEquals(details!)).toBe(true);
        await running.clipboard.claimText(details!);
        await writeFile(
            test.info().outputPath('copy-details-receipt.json'),
            `${JSON.stringify({ copiedMatchesExpandedDetails: true })}\n`,
        );
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
                    join(userData, 'logs', 'desktop.jsonl'),
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
    /**
     * No console-error allowance here on purpose. Through Chromium 152 a `forcefullyCrashRenderer()` left six console
     * errors behind on each observation channel; from Chromium 155 (Electron 45) it leaves none, so allowing them would
     * be exactly the stale suppression this exact-count policy exists to reject. Only this forced-kill path changed:
     * console-error mirroring still works and stays covered by the render-exception test above, which expects and
     * receives its own console errors.
     */
    allowE2EErrors([
        {
            source: 'desktop',
            event: 'process_explorer.render_process_gone',
            code: 'RENDER_PROCESS_GONE',
            count: 3,
        },
        {
            source: 'desktop',
            event: 'process_explorer.render_process_crash_loop',
            code: 'RENDER_PROCESS_CRASH_LOOP',
            count: 1,
        },
    ]);
    test.setTimeout(45_000);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-process-explorer-crash-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const mainLogPath = join(userData, 'logs', 'desktop.jsonl');
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

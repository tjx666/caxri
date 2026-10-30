import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest, runtimeStatus } from './support/helpers.ts';

const MEMORY_UNITS: Record<string, number> = { B: 1 / 1024 / 1024, KB: 1 / 1024, MB: 1, GB: 1024 };

/**
 * Reads a formatted memory cell (`512 KB`, `641.7 MB`, `1.2 GB`) back into MB so sort order can be compared.
 */
function parseMemory(text: string): number {
    const match = /^([\d.]+)\s*([KMG]?B)$/.exec(text.trim());
    if (!match) throw new Error(`Unexpected memory cell: ${text}`);
    return Number(match[1]) * MEMORY_UNITS[match[2]];
}

test('Process Explorer opens one live Caxri process tree and closes independently', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-process-explorer-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
    });
    try {
        await createShellSession(running.page);
        const menuItem = await running.app.evaluate(({ Menu }) => {
            const item = Menu.getApplicationMenu()?.getMenuItemById('command.processExplorer.open');
            return item ? { id: item.id, label: item.label } : undefined;
        });
        expect(menuItem).toEqual({
            id: 'command.processExplorer.open',
            label: 'Open Process Explorer',
        });

        const memoryAction = running.page.getByRole('button', {
            name: /^Open Process Explorer — Terminal memory: [\d.]+ MB$/,
        });
        /**
         * This visible-window workflow owns native keyboard focus and Process Explorer lifecycle. Mouse tooltip
         * behavior for the same shared StatusItem primitive stays covered by `statusbar.e2e.ts`, where the OS pointer
         * is isolated.
         */
        await memoryAction.focus();
        await expect(memoryAction).toBeFocused();
        await memoryAction.press('Enter');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const processPage = running.app.windows().find((page) => page !== running.page)!;
        await processPage.waitForLoadState('domcontentloaded');

        await expect(
            processPage.getByText('Process Explorer — Caxri', { exact: true }),
        ).toBeVisible();
        const grid = processPage.getByRole('treegrid', { name: 'Caxri processes' });
        await expect(grid.getByRole('columnheader')).toHaveCount(5);
        const summary = processPage.getByRole('region', { name: 'Resource summary' });
        await expect(summary).toContainText(/CPU [\d.]+%/);
        await expect(summary).toContainText(/Memory [\d.]+ [KMG]B \/ [\d.]+ [KMG]B/);
        await expect(summary).toContainText(/Processes \d+/);
        await expect(summary).toContainText(/Terminal slots \d+ \/ \d+/);
        /**
         * Caxri's own processes read as role labels, never artifact paths, and the Terminal the Session runs is grouped
         * under that Session instead of nested five levels deep under Main.
         */
        const rowNamed = (name: string) =>
            grid.locator(
                `.process-row:not([data-process-kind="group"]):has(.process-name-cell[data-process-name="${name}"])`,
            );
        await Promise.all(
            ['Caxri', 'Server Core', 'Extension Host', 'Terminal Host'].map((name) =>
                expect(rowNamed(name)).toHaveCount(1),
            ),
        );
        await expect(grid).not.toContainText('/bundles/');
        await expect(grid.locator('[data-process-row-id="group:sessions"]')).toHaveCount(1);
        const terminalRow = grid.locator('.process-row[data-process-kind="terminal"]');
        await expect(terminalRow).toHaveCount(1);
        await expect(terminalRow).toHaveAttribute('aria-expanded', 'false');
        const shellRow = grid.locator(
            '.process-row:has(.process-name-cell[data-process-name="zsh"], .process-name-cell[data-process-name="bash"], .process-name-cell[data-process-name="sh"])',
        );
        await expect(shellRow).toHaveCount(0);
        // Name, CPU, memory, then Slots: the Terminal row counts at least its own PTY, held by Terminal Host.
        await expect(terminalRow.getByRole('gridcell').nth(3)).toHaveText(/^[1-9]\d*$/);
        await terminalRow.click();
        await expect(terminalRow).toHaveAttribute('aria-expanded', 'true');
        await expect(shellRow.first()).toBeVisible();
        /**
         * Rows Caxri owns: the Other apps group appears only while other apps on the machine hold PTYs, which this
         * workflow does not control.
         */
        const caxriRows = processPage.locator(
            '.process-row:not([data-process-row-id="group:other-pty"])',
        );
        const expandedRowCount = await caxriRows.count();
        expect(expandedRowCount).toBeGreaterThan(6);

        const caxriGroup = grid.locator('[data-process-row-id="group:caxri"]');
        await caxriGroup.click();
        const collapsedRowCount = await caxriRows.count();
        expect(collapsedRowCount).toBeLessThan(expandedRowCount - 3);
        await caxriGroup.click();
        await expect(caxriRows).toHaveCount(expandedRowCount);

        /**
         * The filter matches names, PIDs, and command lines, and keeps each match's Session or group above it.
         */
        const filter = processPage.getByRole('searchbox', { name: 'Filter processes' });
        await filter.fill('terminal host');
        await expect(rowNamed('Terminal Host')).toHaveCount(1);
        await expect(rowNamed('Server Core')).toHaveCount(0);
        await filter.fill('no such process anywhere');
        await expect(processPage.getByText(/No processes match/)).toBeVisible();
        await filter.press('Escape');
        await expect(filter).toHaveValue('');
        await expect(caxriRows).toHaveCount(expandedRowCount);

        const sampledAt = Number(
            await processPage.locator('.process-explorer').getAttribute('data-sampled-at'),
        );
        await processPage.getByRole('button', { name: 'Refresh processes' }).click();
        await expect
            .poll(async () =>
                Number(
                    await processPage.locator('.process-explorer').getAttribute('data-sampled-at'),
                ),
            )
            .toBeGreaterThan(sampledAt);

        const mainLogPath = join(userData, 'logs', 'desktop.jsonl');
        await expect
            .poll(async () => {
                const log = await readFile(mainLogPath, 'utf8');
                return log
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line) as { event: string })
                    .filter((record) => record.event === 'process_explorer.sample').length;
            })
            .toBeGreaterThanOrEqual(2);
        const sampleDurations = (await readFile(mainLogPath, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { durationMs?: number; event: string })
            .filter((record) => record.event === 'process_explorer.sample')
            .map((record) => record.durationMs ?? Infinity);
        const maxDurationMs = Math.max(...sampleDurations);
        expect(maxDurationMs).toBeLessThan(1_000);
        console.log(
            'CAXRI_PROCESS_EXPLORER_BENCHMARK',
            JSON.stringify({ samples: sampleDurations.length, maxDurationMs }),
        );

        /**
         * A failed sample must not present the preceding sample as live process data.
         *
         * The visible copy is deliberately plain, so the window records the cause through `console.error`; Main mirrors
         * that into `desktop.jsonl` as an error class plus a digest. Both the direct Renderer capture and that mirrored
         * record are the expected result of the failure injected below, not an unhandled error.
         */
        allowE2EErrors([
            { source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 1 },
            {
                source: 'desktop',
                event: 'process_explorer.console_error',
                code: 'CONSOLE_ERROR',
                count: 1,
            },
        ]);
        await running.app.evaluate(({ app }) => {
            const scope = globalThis as Record<string, unknown>;
            scope.__caxriProcessMetrics = Object.getOwnPropertyDescriptor(app, 'getAppMetrics');
            Object.defineProperty(app, 'getAppMetrics', {
                configurable: true,
                value: () => {
                    throw new Error('Sampling temporarily unavailable');
                },
            });
        });
        try {
            await processPage.getByRole('button', { name: 'Refresh processes' }).click();
            // A failed resample keeps the last table readable and flags it as stale above the rows.
            await expect(processPage.locator('.process-error-line')).toBeVisible();
            await expect(caxriRows.first()).toBeVisible();
            const retry = processPage.getByRole('button', { name: 'Retry', exact: true });
            await expect(retry).toBeVisible();
        } finally {
            await running.app.evaluate(({ app }) => {
                const scope = globalThis as Record<string, unknown>;
                Object.defineProperty(
                    app,
                    'getAppMetrics',
                    scope.__caxriProcessMetrics as PropertyDescriptor,
                );
                Reflect.deleteProperty(scope, '__caxriProcessMetrics');
            });
        }
        const retry = processPage.getByRole('button', { name: 'Retry', exact: true });
        await retry.focus();
        await retry.press('Enter');
        await expect(processPage.locator('.process-error-line')).toHaveCount(0);
        await expect(caxriRows).toHaveCount(expandedRowCount);
        await expect(processPage.getByText('Live · updates every 2 seconds')).toBeVisible();
        await expect(processPage.getByText(/^Updated /)).toBeVisible();

        /**
         * Header sorting reorders siblings without flattening the tree.
         */
        const memoryHeader = grid.getByRole('columnheader', { name: 'Memory' });
        const sortByMemory = grid.getByRole('button', { name: 'Sort by Memory' });
        await expect(memoryHeader).toHaveAttribute('aria-sort', 'none');
        await sortByMemory.click();
        await expect(memoryHeader).toHaveAttribute('aria-sort', 'descending');
        expect(await processPage.locator('.process-row[aria-level="3"]').count()).toBeGreaterThan(
            0,
        );
        const memoryColumn = (
            await grid
                .locator(
                    '.process-row[aria-level="2"]:not([data-process-kind="session"]) [role="gridcell"]:nth-child(3)',
                )
                .allInnerTexts()
        ).map(parseMemory);
        expect(memoryColumn.length).toBeGreaterThan(3);
        expect(memoryColumn).toEqual(memoryColumn.toSorted((left, right) => right - left));
        await sortByMemory.click();
        await expect(memoryHeader).toHaveAttribute('aria-sort', 'ascending');

        /**
         * Dragging a header divider repins that column; double-clicking it returns the name column to auto-fitting the
         * window.
         */
        const nameColumnWidth = (): Promise<number> =>
            grid
                .getByRole('columnheader', { name: 'Name' })
                .evaluate((element) => Math.round(element.getBoundingClientRect().width));
        const autoFittedNameWidth = await nameColumnWidth();
        const resizer = grid.getByRole('separator', { name: 'Resize Name column' });
        const resizerBox = (await resizer.boundingBox())!;
        const resizerY = resizerBox.y + resizerBox.height / 2;
        await processPage.mouse.move(resizerBox.x + resizerBox.width / 2, resizerY);
        await processPage.mouse.down();
        await processPage.mouse.move(resizerBox.x + resizerBox.width / 2 - 150, resizerY, {
            steps: 8,
        });
        await processPage.mouse.up();
        await expect.poll(nameColumnWidth).toBeLessThan(autoFittedNameWidth - 100);
        await resizer.dblclick();
        await expect.poll(nameColumnWidth).toBe(autoFittedNameWidth);

        /**
         * A plain process shows only its executable; the tooltip carrying its untruncated command line hangs off the
         * row, so hovering anywhere on the row still explains it.
         */
        await shellRow.first().locator('.process-name-cell').hover();
        await expect(processPage.locator('.tooltip-popup')).toContainText(/(?:zsh|bash|sh)/);
        await processPage.mouse.move(4, 4);
        await expect(processPage.locator('.tooltip-popup')).toHaveCount(0);

        await running.page.bringToFront();
        const childProcessAction = running.page.getByRole('button', {
            name: /^Open Process Explorer — Terminal: \d+ child processes?$/,
        });
        await childProcessAction.focus();
        await expect(childProcessAction).toBeFocused();
        await childProcessAction.press('Space');
        await expect.poll(() => running.app.windows().length).toBe(2);
        await expect.poll(() => processPage.evaluate(() => document.hasFocus())).toBe(true);

        /**
         * Delete on a focused Terminal row stops (suspends) that Terminal; its row leaves the Sessions group on the
         * next sample while the Session itself survives.
         */
        await terminalRow.focus();
        await terminalRow.press('Delete');
        await expect(terminalRow).toHaveCount(0);
        await expect(grid.locator('[data-process-row-id="group:sessions"]')).toHaveCount(0);

        await processPage.close();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(runtimeStatus(running.page)).toHaveAttribute('data-runtime-status', 'ready');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * Process Explorer follows the app-wide `window.zoomLevel` the same way Caxri Bot does, and remembers its own bounds
 * across an app restart with the same display-clamped persistence; see `CaxriBotWindowController.currentWindowState`
 * and `docs/caxri-bot.md`. It never reopens itself at startup, unlike Caxri Bot.
 */
test('Process Explorer follows the app zoom and remembers its bounds across a restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-process-explorer-state-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    let running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const mainZoomLevel = () =>
        running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
                .find((window) => !window.webContents.getURL().includes('process-explorer.html'))
                ?.webContents.getZoomLevel(),
        );
    const explorerZoomLevel = () =>
        running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('process-explorer.html'))
                ?.webContents.getZoomLevel(),
        );
    const explorerBounds = () =>
        running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('process-explorer.html'))
                ?.getBounds(),
        );
    try {
        await createShellSession(running.page);
        const settings = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        settings.value['window.zoomLevel'] = 1;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings.value),
        });
        expect(running.app.windows().length).toBe(1);
        // Wait for the setting to actually reach Main's zoom controller before opening a window that reads it once at
        // creation; the request resolving does not guarantee the `settings.changed` event has been applied yet.
        await expect.poll(mainZoomLevel).toBe(1);

        await pageRequest(running.page, 'processExplorer.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        await expect.poll(explorerZoomLevel).toBe(1);

        const moved = { x: 30, y: 45, width: 960, height: 620 };
        await running.app.evaluate(({ BrowserWindow }, bounds) => {
            BrowserWindow.getAllWindows()
                .find((window) => window.webContents.getURL().includes('process-explorer.html'))
                ?.setBounds(bounds);
        }, moved);
        await expect.poll(explorerBounds).toEqual(moved);

        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        // Process Explorer never reopens itself at startup, unlike Caxri Bot.
        expect(running.app.windows().length).toBe(1);

        await pageRequest(running.page, 'processExplorer.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        await expect.poll(explorerBounds).toEqual(moved);
        await expect.poll(explorerZoomLevel).toBe(1);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Process Explorer follows the language setting, including while it is open', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-process-explorer-language-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const setLanguage = async (language: AppSettings['workbench.language']) => {
        const settings = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        settings.value['workbench.language'] = language;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings.value),
        });
    };
    try {
        await createShellSession(running.page);
        // The launcher pins the system language to English, so Chinese can only come from the setting.
        await setLanguage('zh-CN');
        await pageRequest(running.page, 'processExplorer.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const processPage = running.app.windows().find((page) => page !== running.page)!;
        await processPage.waitForLoadState('domcontentloaded');

        await expect(processPage.getByRole('treegrid', { name: 'Caxri 进程' })).toBeVisible();
        await expect(processPage.getByRole('region', { name: '资源概览' })).toBeVisible();
        /**
         * The native title is what the Window menu, Mission Control, and the Dock list; the hidden-inset title bar
         * never shows it, so only `BrowserWindow.getTitle()` can prove it follows the language.
         */
        const nativeTitles = () =>
            running.app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows().map((window) => window.getTitle()),
            );
        await expect.poll(nativeTitles).toContain('进程资源管理器 — Caxri');

        await setLanguage('en');
        await expect(processPage.getByRole('treegrid', { name: 'Caxri processes' })).toBeVisible();
        await expect(processPage.getByRole('region', { name: 'Resource summary' })).toBeVisible();
        await expect.poll(nativeTitles).toContain('Process Explorer — Caxri');
        expect(await nativeTitles()).not.toContain('进程资源管理器 — Caxri');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('PTY alert warns near the machine limit, opens Process Explorer, and clears', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-process-explorer-pty-e2e-'));
    const root = join(testDirectory, 'project');
    const overrideFile = join(testDirectory, 'pty-usage-override.json');
    await execFileAsync('mkdir', ['-p', root]);
    /**
     * Replaces the file atomically: Server Core re-reads it on every sample, and a half-written file would fail the
     * sample instead of injecting the reading. Exhausting the runner's real PTYs would break every other terminal on
     * it.
     */
    const injectReading = async (reading: { inUse: number; limit: number }) => {
        const staging = `${overrideFile}.tmp`;
        await writeFile(staging, JSON.stringify(reading), 'utf8');
        await rename(staging, overrideFile);
    };
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
        env: { CAXRI_E2E_PTY_USAGE_OVERRIDE_FILE: overrideFile },
    });
    try {
        const { page } = running;
        await createShellSession(page);
        const alert = page.locator('.toast', { hasText: 'Almost out of terminal slots' });
        await expect(alert).toHaveCount(0);

        await injectReading({ inUse: 450, limit: 511 });
        await expect(alert).toHaveCount(1);
        await expect(alert).toContainText(
            'Almost out of terminal slots (PTYs): 450 of 511 in use.',
        );
        await page.screenshot({ path: test.info().outputPath('pty-alert.png') });

        await alert.getByRole('button', { name: 'View details' }).click();
        await expect.poll(() => running.app.windows().length).toBe(2);
        const processPage = running.app.windows().find((window) => window !== page)!;
        await processPage.waitForLoadState('domcontentloaded');
        const summary = processPage.getByRole('region', { name: 'Resource summary' });
        await expect(summary).toContainText('Terminal slots 450 / 511');
        await expect(summary).toContainText('nearly out of Terminal slots');
        await processPage.screenshot({ path: test.info().outputPath('pty-summary-high.png') });

        // 400 of 511 is still above the 75% clear line, so the notice stays; 300 clears it.
        await injectReading({ inUse: 400, limit: 511 });
        await expect(summary).toContainText('Terminal slots 400 / 511');
        await expect(alert).toHaveCount(1);
        await injectReading({ inUse: 300, limit: 511 });
        await expect(alert).toHaveCount(0);
        await expect(summary).toContainText('Terminal slots 300 / 511');
        await expect(summary).not.toContainText('nearly out of Terminal slots');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

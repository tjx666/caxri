import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, runtimeStatus } from './support/helpers.ts';

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
        await expect(grid.getByRole('columnheader')).toHaveCount(4);
        await expect(grid).toContainText('caxri');
        await expect(
            grid.locator('.process-name-cell[data-process-name="server-core"]'),
        ).toHaveCount(1);
        await expect(
            grid.locator('.process-name-cell[data-process-name="extension-host"]'),
        ).toHaveCount(1);
        await expect(
            grid.locator('.process-name-cell[data-process-name="terminal-host"]'),
        ).toHaveCount(1);
        await expect(grid).not.toContainText('/bundles/extension-host.js');
        await expect(grid).not.toContainText('/bundles/terminal-host.js');
        await expect(grid).toContainText(/\/(?:bin\/)?(?:zsh|bash|sh)/);
        const expandedRowCount = await processPage.locator('.process-row').count();
        expect(expandedRowCount).toBeGreaterThan(3);

        const rootProcess = processPage.locator('.process-name-cell[data-process-name="caxri"]');
        await rootProcess.click({ modifiers: ['Alt'] });
        await expect(processPage.locator('.process-row')).toHaveCount(1);
        await rootProcess.click();
        const partiallyExpandedRowCount = await processPage.locator('.process-row').count();
        expect(partiallyExpandedRowCount).toBeGreaterThan(1);
        expect(partiallyExpandedRowCount).toBeLessThan(expandedRowCount);
        await rootProcess.click();
        await expect(processPage.locator('.process-row')).toHaveCount(1);
        await rootProcess.click({ modifiers: ['Alt'] });
        await expect(processPage.locator('.process-row')).toHaveCount(expandedRowCount);

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
         */
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
            await expect(processPage.locator('.process-error')).toBeVisible();
            await expect(processPage.locator('.process-row')).toHaveCount(0);
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
        await expect(processPage.locator('.process-error')).toHaveCount(0);
        await expect(processPage.locator('.process-row')).toHaveCount(expandedRowCount);
        await expect(processPage.getByText(/Updated .*Refreshes every 2 seconds/)).toBeVisible();

        /**
         * Header sorting reorders siblings without flattening the tree.
         */
        const memoryHeader = grid.getByRole('columnheader', { name: 'Memory (MB)' });
        const sortByMemory = grid.getByRole('button', { name: 'Sort by Memory (MB)' });
        await expect(memoryHeader).toHaveAttribute('aria-sort', 'none');
        await sortByMemory.click();
        await expect(memoryHeader).toHaveAttribute('aria-sort', 'descending');
        expect(await processPage.locator('.process-row[aria-level="3"]').count()).toBeGreaterThan(
            0,
        );
        const memoryColumn = await processPage
            .locator('.process-row[aria-level="2"] [role="gridcell"]:nth-child(3)')
            .allInnerTexts();
        expect(memoryColumn.map(Number)).toEqual(
            memoryColumn.map(Number).toSorted((left, right) => right - left),
        );
        await sortByMemory.click();
        await expect(memoryHeader).toHaveAttribute('aria-sort', 'ascending');

        /**
         * Dragging a header divider repins that column; double-clicking it returns the name column to auto-fitting the
         * window.
         */
        const nameColumnWidth = (): Promise<number> =>
            grid
                .getByRole('columnheader', { name: 'Process Name' })
                .evaluate((element) => Math.round(element.getBoundingClientRect().width));
        const autoFittedNameWidth = await nameColumnWidth();
        const resizer = grid.getByRole('separator', { name: 'Resize Process Name column' });
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
         * A leaf row has no children to expand and therefore renders no control at all: the tooltip carrying its
         * untruncated command line hangs off the row, so hovering anywhere on the row still explains it.
         */
        await grid.locator('.process-name-cell[data-process-name="extension-host"]').hover();
        await expect(processPage.locator('.tooltip-popup')).toHaveText('extension-host');
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

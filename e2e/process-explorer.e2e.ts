import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { createShellSession, launchCaxri, runtimeStatus } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('Process Explorer opens one live Caxri process tree and closes independently', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-process-explorer-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
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

        await running.page.keyboard.press('Meta+Shift+P');
        await running.page
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Process Explorer');
        await running.page.getByText('Open Process Explorer', { exact: true }).click();
        await expect.poll(() => running.app.windows().length).toBe(2);
        const processPage = running.app.windows().find((page) => page !== running.page)!;
        await processPage.waitForLoadState('domcontentloaded');

        await expect(
            processPage.getByText('Process Explorer — Caxri', { exact: true }),
        ).toBeVisible();
        const grid = processPage.getByRole('treegrid', { name: 'Caxri processes' });
        await expect(grid.getByRole('columnheader')).toHaveCount(4);
        await expect(grid).toContainText('caxri');
        await expect(grid).toContainText('runtime');
        await expect(grid).toContainText(/\/(?:bin\/)?(?:zsh|bash|sh)/);
        const expandedRowCount = await processPage.locator('.process-row').count();
        expect(expandedRowCount).toBeGreaterThan(3);

        await processPage.locator('button.process-name[title="caxri"]').click();
        await expect(processPage.locator('.process-row')).toHaveCount(1);
        await processPage.locator('button.process-name[title="caxri"]').click();
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

        const mainLogPath = join(userData, 'logs', 'main.jsonl');
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
            .map((record) => record.durationMs ?? Number.POSITIVE_INFINITY);
        const maxDurationMs = Math.max(...sampleDurations);
        expect(maxDurationMs).toBeLessThan(1_000);
        console.log(
            'CAXRI_PROCESS_EXPLORER_BENCHMARK',
            JSON.stringify({ samples: sampleDurations.length, maxDurationMs }),
        );

        await running.page.bringToFront();
        await running.page.keyboard.press('Meta+Shift+P');
        await running.page
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Process Explorer');
        await running.page.getByText('Open Process Explorer', { exact: true }).click();
        await expect.poll(() => running.app.windows().length).toBe(2);

        await processPage.close();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(runtimeStatus(running.page)).toHaveAttribute('data-runtime-status', 'ready');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxri, openPanelView } from './support/helpers.ts';

interface StructuredLogRecord {
    event?: unknown;
    fields?: Record<string, unknown>;
}

interface LogsQueryE2EControls {
    logsQueryCount(): number;
    logsQueryTimestamps(): number[];
    resetLogsQueryCount(): void;
}

function logsQueryCount(page: Page): Promise<number> {
    return page.evaluate(() =>
        (globalThis as unknown as { caxriE2E: LogsQueryE2EControls }).caxriE2E.logsQueryCount(),
    );
}

function logsQueryTimestamps(page: Page): Promise<number[]> {
    return page.evaluate(() =>
        (
            globalThis as unknown as { caxriE2E: LogsQueryE2EControls }
        ).caxriE2E.logsQueryTimestamps(),
    );
}

function resetLogsQueryCount(page: Page): Promise<void> {
    return page.evaluate(() =>
        (
            globalThis as unknown as { caxriE2E: LogsQueryE2EControls }
        ).caxriE2E.resetLogsQueryCount(),
    );
}

async function countSuccessfulLogQueries(path: string): Promise<number> {
    let source: string;
    try {
        source = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
    }

    let count = 0;
    for (const line of source.split('\n')) {
        if (!line) continue;
        try {
            const record = JSON.parse(line) as StructuredLogRecord;
            if (
                record.event === 'ipc.request' &&
                record.fields?.method === 'logs.query' &&
                record.fields.code === undefined
            )
                count += 1;
        } catch {
            // The logger may still be appending the final line while this bounded assertion reads it.
        }
    }
    return count;
}

test('Logs panel keeps its idle cadence, drains backlog, and ignores its own successful queries', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-logs-panel-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    let isClosed = false;
    try {
        const logsTab = await openPanelView(running.page, 'Logs');
        const panelId = await logsTab.getAttribute('aria-controls');
        if (!panelId) throw new Error('Logs tab is missing its panel association');
        const panel = running.page.locator(`[id=${JSON.stringify(panelId)}]`);

        await expect
            .poll(async () => {
                const timestamps = await logsQueryTimestamps(running.page);
                const stableTail = timestamps.slice(-4);
                return (
                    stableTail.length === 4 &&
                    stableTail
                        .slice(1)
                        .every((timestamp, index) => timestamp - stableTail[index] >= 800)
                );
            })
            .toBe(true);

        await resetLogsQueryCount(running.page);
        await expect
            .poll(() => logsQueryCount(running.page), { timeout: 15_000 })
            .toBeGreaterThanOrEqual(10);
        const cadenceCount = await logsQueryCount(running.page);
        const cadenceTimestamps = await logsQueryTimestamps(running.page);
        expect(cadenceTimestamps.at(-1)! - cadenceTimestamps[0]).toBeGreaterThanOrEqual(8_800);
        expect(cadenceCount).toBeLessThanOrEqual(11);

        const markerId = randomUUID();
        await running.page.evaluate(
            async ([requestCount, finalRequestId]) => {
                const caxri = (
                    globalThis as unknown as {
                        caxri: {
                            requestWithId(
                                id: string,
                                method: string,
                                parameters?: unknown,
                            ): Promise<unknown>;
                        };
                    }
                ).caxri;
                await Promise.all(
                    Array.from({ length: requestCount }, () =>
                        caxri.requestWithId(crypto.randomUUID(), 'app.health'),
                    ),
                );
                await caxri.requestWithId(finalRequestId, 'bugReport.context');
            },
            [60, markerId] as const,
        );

        await panel.locator('input[placeholder^="Filter"]').fill(markerId);

        const matchingRow = panel
            .locator('button[aria-expanded]')
            .filter({ hasText: 'ipc.request' })
            .first();
        await expect(matchingRow).toBeVisible();

        await running.app.close();
        isClosed = true;
        // Closing flushes every structured logger, so this negative assertion cannot pass merely because an async append
        // was still pending when the UI rendered the probe record.
        expect(await countSuccessfulLogQueries(join(userData, 'logs', 'server-core.jsonl'))).toBe(
            0,
        );
    } finally {
        if (!isClosed) {
            try {
                await running.app.close();
            } catch {
                // Ignore close errors during test cleanup.
            }
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

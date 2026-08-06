import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type ElectronApplication } from '@playwright/test';

import { launchCaxriApp, waitForRuntimeReady } from './helpers.ts';

const execFileAsync = promisify(execFile);
const executablePath = process.env.CAXRI_BENCHMARK_EXECUTABLE;
const thresholdMs = 3_000;

interface PerformanceLog {
    event?: string;
    durationMs?: number;
    fields?: Record<string, string | number | boolean | null>;
}

function launch(userData: string, sessionRoot: string): Promise<ElectronApplication> {
    return launchCaxriApp({
        userDataDir: userData,
        testRootPath: sessionRoot,
        executablePath,
    }).then(({ app }) => app);
}

function expectTimedEvent(record: PerformanceLog | undefined): void {
    expect(typeof record?.durationMs).toBe('number');
    expect(record?.durationMs ?? Number.POSITIVE_INFINITY).toBeLessThan(thresholdMs);
}

test('large Project opens Runtime, Terminal, files, and Git within three seconds', async () => {
    // This is a machine-load-sensitive performance assertion, not a functional
    // check, so it only runs when a benchmark Project root is explicitly
    // provided. Without this the default suite would silently fall back to
    // benchmarking the caxri repo itself, which is not representative and
    // flakes under CI load.
    test.skip(
        !process.env.CAXRI_BENCHMARK_PROJECT_ROOT,
        'benchmark: set CAXRI_BENCHMARK_PROJECT_ROOT to run',
    );
    const sessionRoot = resolve(process.env.CAXRI_BENCHMARK_PROJECT_ROOT!);
    const userData = await mkdtemp(join(tmpdir(), 'caxri-startup-benchmark-'));
    const launchedAt = performance.now();
    let app = await launch(userData, sessionRoot);

    try {
        const page = await app.firstWindow();
        if (executablePath) {
            await app.evaluate(({ dialog }, root) => {
                dialog.showOpenDialog = () =>
                    Promise.resolve({ canceled: false, filePaths: [root] });
            }, sessionRoot);
        }
        await waitForRuntimeReady(page);
        const runtimeReadyMs = performance.now() - launchedAt;

        await page.getByRole('button', { name: 'Add Project', exact: true }).last().click();
        const shellButton = page
            .getByRole('dialog')
            .getByRole('button', { name: 'Shell', exact: true });
        await shellButton.waitFor();
        const sessionStartedAt = performance.now();
        await shellButton.click();
        const terminalReady = Promise.all([
            page.locator('.terminal-surface .xterm-rows').waitFor(),
            page.locator('.process-running').waitFor(),
        ]).then(() => performance.now() - sessionStartedAt);
        const filesReady = page
            .locator('.inspector .tree-row')
            .first()
            .waitFor()
            .then(() => performance.now() - sessionStartedAt);
        const [terminalReadyMs, filesReadyMs] = await Promise.all([terminalReady, filesReady]);
        const terminalInput = page.locator('.xterm-helper-textarea').last();
        await terminalInput.focus();
        await terminalInput.pressSequentially("printf 'CAXRI_BENCHMARK_INPUT\\n'");
        await terminalInput.press('Enter');
        await page.waitForFunction(() =>
            document.querySelector('.xterm-rows')?.textContent?.includes('CAXRI_BENCHMARK_INPUT'),
        );

        const gitStartedAt = performance.now();
        await page.getByRole('button', { name: 'Git', exact: true }).click();
        await page.locator('.git-heading').waitFor();
        const gitReadyMs = performance.now() - gitStartedAt;

        await app.close();
        const restoredAt = performance.now();
        app = await launch(userData, sessionRoot);
        const restoredPage = await app.firstWindow();
        const restoredTerminalSurface = restoredPage
            .locator('.terminal-surface .xterm-rows')
            .waitFor()
            .then(() => performance.now() - restoredAt);
        const restoredTerminalReady = restoredPage
            .locator('.process-running')
            .waitFor()
            .then(() => performance.now() - restoredAt);
        const restoredGit = restoredPage
            .locator('.git-heading')
            .waitFor()
            .then(() => performance.now() - restoredAt);
        await waitForRuntimeReady(restoredPage);
        const restoredRuntimeReadyMs = performance.now() - restoredAt;
        const [restoredTerminalSurfaceMs, restoredTerminalReadyMs, restoredGitReadyMs] =
            await Promise.all([restoredTerminalSurface, restoredTerminalReady, restoredGit]);

        const restoredFilesStartedAt = performance.now();
        await restoredPage.getByRole('button', { name: 'Files', exact: true }).click();
        await restoredPage.locator('.inspector .tree-row').first().waitFor();
        const restoredFilesReadyMs = performance.now() - restoredFilesStartedAt;

        const runtimePid = await app.evaluate(
            ({ app: electronApp }) =>
                electronApp.getAppMetrics().find((metric) => metric.name === 'Caxri Runtime')?.pid,
        );
        if (!runtimePid) throw new Error('Caxri Runtime process was not found');
        const { stdout: openFiles } = await execFileAsync('lsof', ['-p', String(runtimePid)]);
        const runtimeOpenDescriptors = openFiles.split('\n').filter(Boolean).length - 1;
        const records = (await readFile(join(userData, 'logs', 'runtime.jsonl'), 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as PerformanceLog);
        const mainRecords = (await readFile(join(userData, 'logs', 'main.jsonl'), 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as PerformanceLog);
        const watcherReady = records.findLast((record) => record.event === 'watcher.ready');
        const watcherFallbacks = records.filter(
            (record) => record.event === 'watcher.fallback',
        ).length;
        const watcherErrors = records.filter(
            (record) => record.event === 'watcher.setup_failed',
        ).length;
        const runtimeBoot = records.findLast((record) => record.event === 'runtime.ready');
        const terminalSpawn = records.findLast((record) => record.event === 'pty.spawned');
        const fileList = records.findLast((record) => record.event === 'file.list');
        const gitCommand = records.findLast((record) => record.event === 'git.command');
        const windowReady = mainRecords.findLast(
            (record) => record.event === 'window.ready_to_show',
        );
        const inputThroughput = records.find(
            (record) => record.event === 'pty.throughput' && Number(record.fields?.inputBytes) > 0,
        );
        const ipcFailures = records.filter(
            (record) => record.event === 'ipc.request_failed',
        ).length;
        const highFrequencyIpcLogs = records.filter(
            (record) =>
                record.event === 'ipc.request' &&
                ['terminal.input', 'terminal.resize'].includes(String(record.fields?.method)),
        ).length;

        const result = {
            executable: executablePath ?? 'development',
            sessionRoot,
            runtimeReadyMs: Math.round(runtimeReadyMs),
            terminalReadyMs: Math.round(terminalReadyMs),
            filesReadyMs: Math.round(filesReadyMs),
            gitReadyMs: Math.round(gitReadyMs),
            restoredRuntimeReadyMs: Math.round(restoredRuntimeReadyMs),
            restoredTerminalSurfaceMs: Math.round(restoredTerminalSurfaceMs),
            restoredTerminalReadyMs: Math.round(restoredTerminalReadyMs),
            restoredFilesReadyMs: Math.round(restoredFilesReadyMs),
            restoredGitReadyMs: Math.round(restoredGitReadyMs),
            runtimeBootMs:
                runtimeBoot?.durationMs === undefined
                    ? undefined
                    : Math.round(runtimeBoot.durationMs * 100) / 100,
            terminalSpawnMs:
                terminalSpawn?.durationMs === undefined
                    ? undefined
                    : Math.round(terminalSpawn.durationMs * 100) / 100,
            fileListMs:
                fileList?.durationMs === undefined
                    ? undefined
                    : Math.round(fileList.durationMs * 100) / 100,
            gitCommandMs:
                gitCommand?.durationMs === undefined
                    ? undefined
                    : Math.round(gitCommand.durationMs * 100) / 100,
            windowReadyMs:
                windowReady?.durationMs === undefined
                    ? undefined
                    : Math.round(windowReady.durationMs * 100) / 100,
            watcherReadyMs:
                watcherReady?.durationMs === undefined
                    ? undefined
                    : Math.round(watcherReady.durationMs * 100) / 100,
            runtimeOpenDescriptors,
            watcherFallbacks,
            watcherErrors,
            ipcFailures,
            highFrequencyIpcLogs,
        };
        console.log(`CAXRI_STARTUP_BENCHMARK ${JSON.stringify(result)}`);

        expect(runtimeReadyMs).toBeLessThan(thresholdMs);
        expect(terminalReadyMs).toBeLessThan(thresholdMs);
        expect(filesReadyMs).toBeLessThan(thresholdMs);
        expect(gitReadyMs).toBeLessThan(thresholdMs);
        expect(restoredRuntimeReadyMs).toBeLessThan(thresholdMs);
        expect(restoredTerminalSurfaceMs).toBeLessThan(thresholdMs);
        expect(restoredTerminalReadyMs).toBeLessThan(thresholdMs);
        expect(restoredFilesReadyMs).toBeLessThan(thresholdMs);
        expect(restoredGitReadyMs).toBeLessThan(thresholdMs);
        expectTimedEvent(runtimeBoot);
        expectTimedEvent(terminalSpawn);
        expectTimedEvent(fileList);
        expectTimedEvent(gitCommand);
        expectTimedEvent(windowReady);
        expect(watcherReady?.fields?.backend).toMatch(/^(fs-events|poll)$/);
        expect(inputThroughput?.fields?.inputBytes).toBeGreaterThan(0);
        expect(runtimeOpenDescriptors).toBeLessThan(256);
        expect(watcherErrors).toBe(0);
        expect(ipcFailures).toBe(0);
        expect(highFrequencyIpcLogs).toBe(0);
    } finally {
        await app.close().catch(() => undefined);
        await rm(userData, { recursive: true, force: true });
    }
});

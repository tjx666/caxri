import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { connectToHost } from '@caxri/client/supervise';
import { execFileAsync } from '@caxri/system';

import type { E2EApp as ElectronApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { launchCaxriApp, openAddProjectDialog, waitForRuntimeReady } from './support/helpers.ts';

const executablePath = process.env.CAXRI_BENCHMARK_EXECUTABLE;
const thresholdMs = 3_000;

interface PerformanceLog {
    event?: string;
    durationMs?: number;
    fields?: Record<string, string | number | boolean | null>;
}

async function launch(
    userData: string,
    sessionRoot: string,
    shouldPreserveHostOnClose: boolean,
): Promise<ElectronApp> {
    const { app } = await launchCaxriApp({
        userDataDir: userData,
        testRootPath: sessionRoot,
        executablePath,
        preserveHostOnClose: shouldPreserveHostOnClose,
    });
    return app;
}

function expectTimedEvent(record: PerformanceLog | undefined): void {
    expect(typeof record?.durationMs).toBe('number');
    expect(record?.durationMs ?? Infinity).toBeLessThan(thresholdMs);
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
    let app = await launch(userData, sessionRoot, true);

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

        await openAddProjectDialog(page);
        const shellButton = page
            .getByRole('dialog')
            .getByRole('button', { name: 'Shell', exact: true });
        await shellButton.waitFor();
        const sessionStartedAt = performance.now();
        await shellButton.click();
        const terminalReady = (async () => {
            await Promise.all([
                page.locator('.terminal-surface .xterm-rows').waitFor(),
                page.locator('.process-running').waitFor(),
            ]);
            return performance.now() - sessionStartedAt;
        })();
        const filesReady = (async () => {
            await page.locator('.secondary-sidebar .tree-row').first().waitFor();
            return performance.now() - sessionStartedAt;
        })();
        const [terminalReadyMs, filesReadyMs] = await Promise.all([terminalReady, filesReady]);
        const terminalInput = page.locator('.xterm-helper-textarea').last();
        await terminalInput.focus();
        const terminalOutputMarker = 'CAXRI_BENCHMARK_OUTPUT';
        await terminalInput.pressSequentially(
            String.raw`printf '\103\101\130\122\111\137\102\105\116\103\110\115\101\122\113\137\117\125\124\120\125\124\012'`,
        );
        /**
         * Exclude Playwright's synthetic typing schedule from the guest echo latency budget.
         */
        const terminalEchoStartedAt = performance.now();
        await terminalInput.press('Enter');
        await page.waitForFunction(
            (marker) => document.querySelector('.xterm-rows')?.textContent.includes(marker),
            terminalOutputMarker,
        );
        const terminalEchoMs = performance.now() - terminalEchoStartedAt;

        const gitStartedAt = performance.now();
        await page.getByRole('tab', { name: 'Git', exact: true }).click();
        await page.locator('.git-heading').waitFor();
        const gitReadyMs = performance.now() - gitStartedAt;

        await app.close();
        const restoredAt = performance.now();
        app = await launch(userData, sessionRoot, false);
        const restoredPage = await app.firstWindow();
        const restoredTerminalSurface = (async () => {
            await restoredPage.locator('.terminal-surface .xterm-rows').waitFor();
            return performance.now() - restoredAt;
        })();
        const restoredTerminalReady = (async () => {
            await restoredPage.locator('.process-running').waitFor();
            return performance.now() - restoredAt;
        })();
        const restoredGit = (async () => {
            await restoredPage.locator('.git-heading').waitFor();
            return performance.now() - restoredAt;
        })();
        await waitForRuntimeReady(restoredPage);
        const restoredRuntimeReadyMs = performance.now() - restoredAt;
        const [restoredTerminalSurfaceMs, restoredTerminalReadyMs, restoredGitReadyMs] =
            await Promise.all([restoredTerminalSurface, restoredTerminalReady, restoredGit]);

        const restoredFilesStartedAt = performance.now();
        await restoredPage.getByRole('tab', { name: 'Files', exact: true }).click();
        await restoredPage.locator('.secondary-sidebar .tree-row').first().waitFor();
        const restoredFilesReadyMs = performance.now() - restoredFilesStartedAt;

        const host = await connectToHost(userData, 2_000);
        const serverPid = (await host.request('host.status')).pid;
        const projectListRoundTripMs: number[] = [];
        for (let index = 0; index < 10; index += 1) {
            const startedAt = performance.now();
            // Sequential samples isolate normal request latency from deliberate queue pressure.
            // eslint-disable-next-line no-await-in-loop
            await host.request('project.list');
            projectListRoundTripMs.push(performance.now() - startedAt);
        }
        host.close();
        const [{ stdout: openFiles }, { stdout: residentSet }] = await Promise.all([
            execFileAsync('lsof', ['-p', String(serverPid)]),
            execFileAsync('ps', ['-o', 'rss=', '-p', String(serverPid)]),
        ]);
        const runtimeOpenDescriptors = openFiles.split('\n').filter(Boolean).length - 1;
        const runtimeMemoryMb = Number(residentSet.trim()) / 1024;
        // The logger now drains writes asynchronously, so poll the log files instead of reading
        // them once: the final `git.summary`/`window.ready_to_show` records may not be flushed
        // to disk yet. Keep polling until both are present, then read the settled records below.
        let records: PerformanceLog[] = [];
        let mainRecords: PerformanceLog[] = [];
        await expect
            .poll(
                async () => {
                    records = (await readFile(join(userData, 'logs', 'runtime.jsonl'), 'utf8'))
                        .split('\n')
                        .filter(Boolean)
                        .map((line) => JSON.parse(line) as PerformanceLog);
                    mainRecords = (await readFile(join(userData, 'logs', 'main.jsonl'), 'utf8'))
                        .split('\n')
                        .filter(Boolean)
                        .map((line) => JSON.parse(line) as PerformanceLog);
                    return (
                        mainRecords.some((record) => record.event === 'window.ready_to_show') &&
                        records.some(
                            (record) =>
                                record.event === 'git.summary' &&
                                record.fields?.outcome === 'fresh',
                        )
                    );
                },
                { timeout: 10_000 },
            )
            .toBe(true);
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
        // The three-second Git gate covers the whole summary production (discovery + status +
        // numstat wall time and command count), not the last individual `git.command` record.
        const gitSummaries = records.filter(
            (record) => record.event === 'git.summary' && record.fields?.outcome === 'fresh',
        );
        const gitSummary = gitSummaries.at(-1);
        /**
         * Only the cold summary is guaranteed to spawn Git commands; a later fresh production can legitimately report
         * zero when the topology registry and status snapshot are warm.
         */
        const coldGitSummaryFields = gitSummaries.at(0)?.fields;
        const gitSummariesJoined = records.filter(
            (record) => record.event === 'git.summary' && record.fields?.outcome === 'joined',
        ).length;
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
            terminalEchoMs: Math.round(terminalEchoMs * 100) / 100,
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
            gitSummaryMs:
                gitSummary?.durationMs === undefined
                    ? undefined
                    : Math.round(gitSummary.durationMs * 100) / 100,
            gitSummaryCommandCount: coldGitSummaryFields?.commandCount,
            gitSummariesFresh: gitSummaries.length,
            gitSummariesJoined,
            windowReadyMs:
                windowReady?.durationMs === undefined
                    ? undefined
                    : Math.round(windowReady.durationMs * 100) / 100,
            watcherReadyMs:
                watcherReady?.durationMs === undefined
                    ? undefined
                    : Math.round(watcherReady.durationMs * 100) / 100,
            runtimeOpenDescriptors,
            runtimeMemoryMb: Math.round(runtimeMemoryMb * 100) / 100,
            projectListRoundTripMs: projectListRoundTripMs.map(
                (duration) => Math.round(duration * 100) / 100,
            ),
            watcherFallbacks,
            watcherErrors,
            ipcFailures,
            highFrequencyIpcLogs,
        };
        console.log(`CAXRI_STARTUP_BENCHMARK ${JSON.stringify(result)}`);

        expect(runtimeReadyMs).toBeLessThan(thresholdMs);
        expect(terminalReadyMs).toBeLessThan(thresholdMs);
        expect(terminalEchoMs).toBeLessThan(500);
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
        // Every fresh summary production across cold start and restore stays under the gate; a
        // joined/coalesced consumer never spawns its own command chain so only `fresh` is timed.
        expect(gitSummaries.length).toBeGreaterThan(0);
        for (const summaryRecord of gitSummaries) expectTimedEvent(summaryRecord);
        expect(Number(coldGitSummaryFields?.commandCount)).toBeGreaterThan(0);
        expectTimedEvent(windowReady);
        expect(watcherReady?.fields?.backend).toMatch(/^(fs-events|poll)$/);
        expect(inputThroughput?.fields?.inputBytes).toBeGreaterThan(0);
        expect(runtimeOpenDescriptors).toBeLessThan(256);
        expect(runtimeMemoryMb).toBeLessThan(512);
        expect(Math.max(...projectListRoundTripMs)).toBeLessThan(100);
        expect(watcherErrors).toBe(0);
        expect(ipcFailures).toBe(0);
        expect(highFrequencyIpcLogs).toBe(0);
    } finally {
        try {
            await app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(userData, { recursive: true, force: true });
    }
});

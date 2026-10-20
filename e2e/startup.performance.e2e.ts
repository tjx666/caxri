import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { connectToServer } from '@caxri/client/supervise';
import { execFileAsync } from '@caxri/system';

import { annotateE2ETimings } from '../scripts/reporters/public-e2e-diagnostics.ts';
import type { E2EApp as ElectronApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import type { LaunchCaxriOptions } from './support/helpers.ts';
import {
    launchCaxriApp,
    openAddProjectDialog,
    VISIBLE_TERMINAL_INPUT,
    waitForRuntimeReady,
} from './support/helpers.ts';

const executablePath = process.env.CAXRI_BENCHMARK_EXECUTABLE;
const thresholdMs = 3_000;

interface PerformanceLog {
    event?: string;
    level?: string;
    durationMs?: number;
    fields?: Record<string, string | number | boolean | null>;
}

async function launch(
    userData: string,
    sessionRoot: string,
    shouldPreserveHostOnClose: boolean,
    onLaunchStage: LaunchCaxriOptions['onLaunchStage'],
): Promise<ElectronApp> {
    const { app } = await launchCaxriApp({
        userDataDir: userData,
        testRootPath: sessionRoot,
        executablePath,
        preserveHostOnClose: shouldPreserveHostOnClose,
        onLaunchStage,
        env: { PATH: `${join(userData, 'benchmark-bin')}:${process.env.PATH ?? ''}` },
    });
    return app;
}

function expectTimedEvent(record: PerformanceLog | undefined): void {
    expect(typeof record?.durationMs).toBe('number');
    expect(record?.durationMs ?? Infinity).toBeLessThan(thresholdMs);
}

interface ServerOwnerProcess {
    command: string;
    pid: number;
    ppid: number;
    rssKiB: number;
}

/**
 * Measures every general Server owner that replaced the legacy Host + Runtime pair. Extension Host remains excluded
 * because it was already independent in A0; Terminal Host is included once A3b splits it from Server Core. This keeps
 * the same memory and descriptor budget meaningful across deliberate process-topology changes.
 */
async function measureServerOwnerResources(serverCorePid: number): Promise<{
    memoryMb: number;
    openDescriptors: number;
}> {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command=']);
    const processes = stdout
        .split('\n')
        .filter(Boolean)
        .map((line): ServerOwnerProcess => {
            const [pid, ppid, rssKiB, ...command] = line.trim().split(/\s+/u);
            if (!pid || !ppid || !rssKiB || command.length === 0)
                throw new Error(`Unexpected process resource record: ${line}`);
            return {
                command: command.join(' '),
                pid: Number(pid),
                ppid: Number(ppid),
                rssKiB: Number(rssKiB),
            };
        });
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const isServerDescendant = (entry: ServerOwnerProcess): boolean => {
        const visited = new Set<number>();
        let current: ServerOwnerProcess | undefined = entry;
        while (current && !visited.has(current.pid)) {
            if (current.ppid === serverCorePid) return true;
            visited.add(current.pid);
            current = byPid.get(current.ppid);
        }
        return false;
    };
    const owners = processes.filter(
        (entry) =>
            entry.pid === serverCorePid ||
            (isServerDescendant(entry) && /(?:^|\/)terminal-host\.js(?:\s|$)/u.test(entry.command)),
    );
    if (owners.every((entry) => entry.pid !== serverCorePid))
        throw new Error('Server Core process disappeared before resource measurement');
    const descriptorCounts = await Promise.all(
        owners.map(async ({ pid }) => {
            const { stdout: openFiles } = await execFileAsync('lsof', ['-p', String(pid)]);
            return openFiles.split('\n').filter(Boolean).length - 1;
        }),
    );
    return {
        memoryMb: owners.reduce((total, entry) => total + entry.rssKiB, 0) / 1024,
        openDescriptors: descriptorCounts.reduce((total, count) => total + count, 0),
    };
}

test('large Project opens Runtime, Terminal, files, and Git within three seconds', async () => {
    const testInfo = test.info();
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
    /**
     * Keep the real repository's local Git workload, but isolate PR discovery from network and login state when the
     * benchmark root is on a named branch. Both cold and restored launches use this same offline response.
     */
    const benchmarkBin = join(userData, 'benchmark-bin');
    await mkdir(benchmarkBin);
    await writeFile(
        join(benchmarkBin, 'gh'),
        String.raw`#!/bin/sh
# 为启动性能测试提供离线的无 PR 响应，不修改仓库或外部状态。
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\n' 'no pull requests found for branch benchmark' >&2
  exit 1
fi
printf '%s\n' 'Unexpected GitHub CLI fixture invocation' >&2
exit 2
`,
        { mode: 0o755 },
    );
    const launchedAt = performance.now();
    let app = await launch(userData, sessionRoot, true, (stage, durationMs) =>
        annotateE2ETimings(testInfo, 'coldLaunch', { [stage]: durationMs }),
    );
    const launchHelperMs = performance.now() - launchedAt;

    try {
        const page = await app.firstWindow();
        const dialogStubStartedAt = performance.now();
        if (executablePath) {
            await app.evaluate(({ dialog }, root) => {
                dialog.showOpenDialog = () =>
                    Promise.resolve({ canceled: false, filePaths: [root] });
            }, sessionRoot);
        }
        const packagedDialogStubMs = executablePath ? performance.now() - dialogStubStartedAt : 0;
        const runtimeStatusStartedAt = performance.now();
        await waitForRuntimeReady(page);
        const runtimeStatusWaitMs = performance.now() - runtimeStatusStartedAt;
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
                page.locator('.terminal-surface[data-terminal-attached="true"]').waitFor(),
            ]);
            return performance.now() - sessionStartedAt;
        })();
        const filesReady = (async () => {
            await page.locator('.secondary-sidebar .tree-row').first().waitFor();
            return performance.now() - sessionStartedAt;
        })();
        const [terminalReadyMs, filesReadyMs] = await Promise.all([terminalReady, filesReady]);
        const terminalInput = page.locator(VISIBLE_TERMINAL_INPUT).last();
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
        app = await launch(userData, sessionRoot, false, (stage, durationMs) =>
            annotateE2ETimings(testInfo, 'restoredLaunch', { [stage]: durationMs }),
        );
        const restoredPage = await app.firstWindow();
        const restoredTerminalSurface = (async () => {
            await restoredPage.locator('.terminal-surface .xterm-rows').waitFor();
            return performance.now() - restoredAt;
        })();
        const restoredTerminalReady = (async () => {
            await restoredPage
                .locator('.terminal-surface[data-terminal-attached="true"]')
                .waitFor();
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

        const server = await connectToServer(userData, 2_000);
        const serverPid = (await server.request('host.status')).pid;
        const projectListRoundTripMs: number[] = [];
        for (let index = 0; index < 10; index += 1) {
            const startedAt = performance.now();
            // Sequential samples isolate normal request latency from deliberate queue pressure.
            // eslint-disable-next-line no-await-in-loop
            await server.request('project.list');
            projectListRoundTripMs.push(performance.now() - startedAt);
        }
        server.close();
        const serverResources = await measureServerOwnerResources(serverPid);
        // The logger now drains writes asynchronously, so poll the log files instead of reading
        // them once: the final Core, Desktop, and Terminal Host records may not be flushed to disk yet. Poll every
        // owning process so moving PTY execution does not make the first-input gate silently inspect the wrong log.
        let records: PerformanceLog[] = [];
        let desktopRecords: PerformanceLog[] = [];
        let terminalHostRecords: PerformanceLog[] = [];
        await expect
            .poll(
                async () => {
                    records = (await readFile(join(userData, 'logs', 'server-core.jsonl'), 'utf8'))
                        .split('\n')
                        .filter(Boolean)
                        .map((line) => JSON.parse(line) as PerformanceLog);
                    desktopRecords = (
                        await readFile(join(userData, 'logs', 'desktop.jsonl'), 'utf8')
                    )
                        .split('\n')
                        .filter(Boolean)
                        .map((line) => JSON.parse(line) as PerformanceLog);
                    terminalHostRecords = (
                        await readFile(join(userData, 'logs', 'terminal-host.jsonl'), 'utf8')
                    )
                        .split('\n')
                        .filter(Boolean)
                        .map((line) => JSON.parse(line) as PerformanceLog);
                    return (
                        desktopRecords.some((record) => record.event === 'window.ready_to_show') &&
                        records.some(
                            (record) =>
                                record.event === 'git.summary' &&
                                record.fields?.outcome === 'fresh',
                        ) &&
                        terminalHostRecords.some(
                            (record) =>
                                record.event === 'pty.first_input' &&
                                Number(record.fields?.inputBytes) > 0,
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
        const serverCoreBoot = records.findLast((record) => record.event === 'server_core.ready');
        const terminalSpawn = records.findLast((record) => record.event === 'pty.spawned');
        const fileList = records.findLast((record) => record.event === 'file.list');
        const gitCommand = records.findLast((record) => record.event === 'git.command');
        // The three-second Git gate covers the whole summary production (discovery + status +
        // numstat wall time and command count), not the last individual `git.command` record.
        // Server Core logs at `info`, where a production whose result repeats the previous one for
        // the Session is not written (#604); this therefore counts changed productions, which always
        // includes the cold one of each Server lifetime.
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
        const windowReady = desktopRecords.findLast(
            (record) => record.event === 'window.ready_to_show',
        );
        // Steady-state throughput lives in the metrics layer; the one-shot `pty.first_input` record is the
        // low-frequency liveness signal that proves Renderer input reached the PTY (#590).
        const inputThroughput = terminalHostRecords.find(
            (record) => record.event === 'pty.first_input' && Number(record.fields?.inputBytes) > 0,
        );
        const ipcFailures = records.filter(
            (record) =>
                record.event === 'ipc.request_failed' &&
                (record.level === 'error' || record.level === 'fatal'),
        ).length;
        const highFrequencyIpcLogs = records.filter(
            (record) =>
                record.event === 'ipc.request' &&
                ['terminal.input', 'terminal.resize'].includes(String(record.fields?.method)),
        ).length;

        const result = {
            executable: executablePath ?? 'development',
            sessionRoot,
            launchHelperMs,
            packagedDialogStubMs,
            runtimeStatusWaitMs,
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
            serverCoreBootMs:
                serverCoreBoot?.durationMs === undefined
                    ? undefined
                    : Math.round(serverCoreBoot.durationMs * 100) / 100,
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
            serverOpenDescriptors: serverResources.openDescriptors,
            serverMemoryMb: Math.round(serverResources.memoryMb * 100) / 100,
            projectListRoundTripMs: projectListRoundTripMs.map(
                (duration) => Math.round(duration * 100) / 100,
            ),
            watcherFallbacks,
            watcherErrors,
            ipcFailures,
            highFrequencyIpcLogs,
        };
        // Public CI must not print the legacy result's executable or Project paths.
        annotateE2ETimings(testInfo, 'benchmark', result);
        const coldProfile = desktopRecords.find((record) => record.event === 'app.startup_profile');
        annotateE2ETimings(testInfo, 'coldProfile', coldProfile?.fields ?? {});
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
        expectTimedEvent(serverCoreBoot);
        expectTimedEvent(terminalSpawn);
        expectTimedEvent(fileList);
        // Every *changed* fresh summary production stays under the gate: Server Core logs at `info`,
        // where GitSummaryTelemetry keeps only productions whose fingerprint changed, and the restore
        // launch reuses the preserved Server Core, so an identical restore snapshot is not in this set.
        // A joined/coalesced consumer never spawns its own command chain so only `fresh` is timed.
        expect(gitSummaries.length).toBeGreaterThan(0);
        for (const summaryRecord of gitSummaries) expectTimedEvent(summaryRecord);
        expect(Number(coldGitSummaryFields?.commandCount)).toBeGreaterThan(0);
        expectTimedEvent(windowReady);
        expect(watcherReady?.fields?.backend).toMatch(/^(fs-events|poll)$/);
        expect(inputThroughput?.fields?.inputBytes).toBeGreaterThan(0);
        expect(serverResources.openDescriptors).toBeLessThan(256);
        expect(serverResources.memoryMb).toBeLessThan(512);
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

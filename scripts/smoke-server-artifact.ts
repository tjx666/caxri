#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { connectDesktopToServer, ensureServer } from '@caxri/client/supervise';
import type { TerminalSnapshot } from '@caxri/protocol';
import {
    observationProcessManifestDirectory,
    observationProcessOwners,
    readObservationProcessManifests,
} from '@caxri/system';

import { verifyServerArtifact } from '../apps/server/scripts/artifact';

const root = resolve(import.meta.dirname, '..');
const sourceArtifact = resolve(root, 'apps/server/dist/server');
const execFileAsync = promisify(execFile);

async function hasPath(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
    }
}

async function waitForCleanShutdown(pid: number, manifestPath: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        let isAlive = true;
        try {
            process.kill(pid, 0);
        } catch {
            isAlive = false;
        }
        // eslint-disable-next-line no-await-in-loop -- process exit and manifest removal form one shutdown condition
        if (!isAlive && !(await hasPath(manifestPath))) return;
        // eslint-disable-next-line no-await-in-loop -- ordered process and manifest shutdown observation
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Copied Server artifact did not shut down cleanly');
}

async function printFailureLogTail(profile: string, source: string): Promise<void> {
    const path = join(profile, 'logs', `${source}.jsonl`);
    if (!(await hasPath(path))) return;
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').slice(-40);
    process.stderr.write(`\n[${source} log tail]\n${lines.join('\n')}\n`);
}

async function waitForObservationManifests(profile: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- waits for three independently published process receipts.
        const manifests = await readObservationProcessManifests(
            observationProcessManifestDirectory(profile),
        );
        if (
            observationProcessOwners.every(
                (owner) =>
                    manifests[owner]?.state === 'ready' &&
                    ['process.memory', 'process.open_fds'].every((name) =>
                        manifests[owner]?.metrics?.series.some((series) => series.name === name),
                    ),
            )
        )
            return manifests;
        // eslint-disable-next-line no-await-in-loop -- bounded receipt publication polling.
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Standalone Server did not publish bounded ready process manifests');
}

async function waitForStoppedObservationManifests(profile: string) {
    const deadline = Date.now() + 5_000;
    let states = 'missing';
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- waits for three independently flushed shutdown receipts.
        const manifests = await readObservationProcessManifests(
            observationProcessManifestDirectory(profile),
        );
        states = observationProcessOwners
            .map((owner) => `${owner}:${manifests[owner]?.state ?? 'missing'}`)
            .join(',');
        if (observationProcessOwners.every((owner) => manifests[owner]?.state === 'stopped'))
            return manifests;
        // eslint-disable-next-line no-await-in-loop -- bounded receipt publication polling.
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Standalone Server did not flush stopped process manifests (${states})`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'caxri-standalone-server-'));
const copiedArtifact = join(temporaryRoot, 'server');
const profile = join(temporaryRoot, 'profile');
const projectRoot = join(temporaryRoot, 'project');
const manifestPath = join(profile, 'host', 'manifest.json');
let desktop: Awaited<ReturnType<typeof connectDesktopToServer>> | undefined;
let operator: Awaited<ReturnType<typeof ensureServer>> | undefined;
let serverPid: number | undefined;
try {
    await cp(sourceArtifact, copiedArtifact, { recursive: true, verbatimSymlinks: true });
    await Promise.all([
        mkdir(profile, { recursive: true }),
        mkdir(projectRoot, { recursive: true }),
    ]);
    const searchMarker = `caxri-project-search-smoke-${process.pid}`;
    await writeFile(join(projectRoot, 'search-smoke.txt'), `${searchMarker}\n`, 'utf8');
    const sourceManifest = await verifyServerArtifact(sourceArtifact);
    const copiedManifest = await verifyServerArtifact(copiedArtifact);
    if (JSON.stringify(sourceManifest) !== JSON.stringify(copiedManifest)) {
        throw new Error('Copied Server artifact inputs are not byte-identical');
    }
    const ripgrep = await execFileAsync(join(copiedArtifact, 'runtime', 'bin', 'rg'), [
        '--no-config',
        '--fixed-strings',
        '--',
        searchMarker,
        join(projectRoot, 'search-smoke.txt'),
    ]);
    if (!ripgrep.stdout.includes(searchMarker))
        throw new Error('Copied Server artifact ripgrep executable did not return a match');

    const readyStartedAt = performance.now();
    operator = await ensureServer(profile, { artifactRoot: copiedArtifact }, 15_000);
    const readyMs = performance.now() - readyStartedAt;
    const status = await operator.request('host.status');
    serverPid = status.pid;
    desktop = await connectDesktopToServer(profile, 'server-artifact-smoke', () =>
        Promise.reject(new Error('Standalone Server smoke received an unexpected command')),
    );
    await desktop.markDesktopReady();
    const project = await desktop.requestServerOperation('project.create', {
        rootPath: projectRoot,
    });
    const created = await desktop.request('session.create', {
        projectId: project.id,
        defaultAgent: 'shell',
    });
    if (!created.terminal) throw new Error('Terminal Host smoke fixture did not create a Terminal');
    const terminalId = created.terminal.id;
    await desktop.request('terminal.attach', { terminalId, cols: 80, rows: 24 });
    const restarted = await desktop.request('terminal.restart', { terminalId, mode: 'fresh' });
    if (restarted.lastProcessState !== 'running')
        throw new Error('Standalone Terminal Host did not start the seeded shell');
    await desktop.request('terminal.resize', { terminalId, cols: 96, rows: 32 });
    const marker = `caxri-terminal-host-smoke-${process.pid}`;
    await desktop.request('terminal.input', { terminalId, data: `printf '${marker}\\n'\r` });
    let terminalSnapshot: TerminalSnapshot | null = null;
    const outputDeadline = Date.now() + 5_000;
    while (Date.now() < outputDeadline) {
        // eslint-disable-next-line no-await-in-loop -- snapshot polling observes the real cross-process PTY output.
        terminalSnapshot = await desktop.request('terminal.snapshot', { terminalId });
        if (terminalSnapshot?.payload.includes(marker)) break;
        // eslint-disable-next-line no-await-in-loop -- bounded PTY observation polling.
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!terminalSnapshot?.payload.includes(marker))
        throw new Error('Standalone Terminal Host did not capture shell output');
    if (terminalSnapshot.cols !== 96 || terminalSnapshot.rows !== 32)
        throw new Error('Standalone Terminal Host did not preserve the requested grid');
    const resources = await desktop.request('terminal.resources', { terminalId });
    if (!resources) throw new Error('Standalone Terminal Host did not expose PTY resources');
    if ((await desktop.request('terminal.runningCount', {})).terminals !== 1)
        throw new Error('Standalone Terminal Host running count is inconsistent');
    const observationManifests = await waitForObservationManifests(profile);
    await desktop.request('terminal.close', { terminalId });
    if ((await desktop.request('terminal.runningCount', {})).terminals !== 0)
        throw new Error('Standalone Terminal Host did not retire the closed PTY');
    desktop.close();
    desktop = undefined;
    await operator.request('host.stop', { confirmLivePtys: true });
    operator.close();
    operator = undefined;
    const shutdownStartedAt = performance.now();
    await waitForCleanShutdown(status.pid, manifestPath);
    const stoppedObservationManifests = await waitForStoppedObservationManifests(profile);
    const shutdownMs = performance.now() - shutdownStartedAt;

    const receipt = {
        architecture: sourceManifest.architecture,
        artifactSha256: sourceManifest.integrity.aggregateSha256,
        checkId: 'architecture-a2f-standalone-artifact',
        commit: sourceManifest.commit,
        fileCount: sourceManifest.integrity.files.length,
        handshake: {
            protocolVersion: sourceManifest.protocolVersion,
            version: status.version,
        },
        readyMs: Number(readyMs.toFixed(2)),
        ripgrep: {
            checkId: 'project-search-bundled-ripgrep',
            matchObserved: true,
        },
        observability: {
            checkId: 'architecture-a6-agent-observability',
            owners: Object.fromEntries(
                observationProcessOwners.map((owner) => [
                    owner,
                    {
                        metricSeries: observationManifests[owner]!.metrics!.series.length,
                        state: stoppedObservationManifests[owner]!.state,
                    },
                ]),
            ),
        },
        runtimeVersion: sourceManifest.runtime.version,
        schemaVersion: 2,
        shutdown: { clean: true, shutdownMs: Number(shutdownMs.toFixed(2)) },
        terminalHost: {
            checkId: 'architecture-a3b-terminal-host',
            childProcessCount: resources.childProcessCount,
            memoryMb: Number(resources.memoryMb.toFixed(2)),
            outputObserved: true,
            resizedGrid: { cols: terminalSnapshot.cols, rows: terminalSnapshot.rows },
            snapshotBytes: terminalSnapshot.byteCount,
            state: stoppedObservationManifests['terminal-host']!.state,
        },
    };
    const receiptDirectory = resolve(root, '.records/server-artifact');
    await mkdir(receiptDirectory, { recursive: true });
    const receiptPath = join(receiptDirectory, `a2f-${sourceManifest.commit}.json`);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
    await Promise.all([
        printFailureLogTail(profile, 'server-core'),
        printFailureLogTail(profile, 'terminal-host'),
    ]);
    throw error;
} finally {
    desktop?.close({ cancelPendingRequests: true });
    if (operator) {
        try {
            await operator.request('host.stop', { confirmLivePtys: true });
        } catch {
            // The failed request may already have closed the Server; the bounded PID wait below is authoritative.
        }
        operator.close({ cancelPendingRequests: true });
    }
    if (serverPid !== undefined) {
        try {
            await waitForCleanShutdown(serverPid, manifestPath);
        } catch {
            try {
                process.kill(serverPid, 'SIGTERM');
                await waitForCleanShutdown(serverPid, manifestPath);
            } catch {
                // Preserve the original smoke failure after both graceful and signal cleanup attempts.
            }
        }
    }
    await rm(temporaryRoot, { force: true, recursive: true });
}

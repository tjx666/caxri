#!/usr/bin/env bun

import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { ensureHost } from '@caxri/client/supervise';

import { verifyServerArtifact } from '../apps/server/scripts/artifact';

const root = resolve(import.meta.dirname, '..');
const sourceArtifact = resolve(root, 'apps/server/dist/server');

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

const temporaryRoot = await mkdtemp(join(tmpdir(), 'caxri-standalone-server-'));
try {
    const copiedArtifact = join(temporaryRoot, 'server');
    const profile = join(temporaryRoot, 'profile');
    await cp(sourceArtifact, copiedArtifact, { recursive: true, verbatimSymlinks: true });
    const sourceManifest = await verifyServerArtifact(sourceArtifact);
    const copiedManifest = await verifyServerArtifact(copiedArtifact);
    if (JSON.stringify(sourceManifest) !== JSON.stringify(copiedManifest)) {
        throw new Error('Copied Server artifact inputs are not byte-identical');
    }

    const readyStartedAt = performance.now();
    const client = await ensureHost(profile, { artifactRoot: copiedArtifact }, 15_000);
    const readyMs = performance.now() - readyStartedAt;
    const status = await client.request('host.status');
    await client.request('host.stop', { confirmLivePtys: true });
    client.close();
    const shutdownStartedAt = performance.now();
    await waitForCleanShutdown(status.pid, join(profile, 'host', 'manifest.json'));
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
        runtimeVersion: sourceManifest.runtime.version,
        schemaVersion: 1,
        shutdown: { clean: true, shutdownMs: Number(shutdownMs.toFixed(2)) },
    };
    const receiptDirectory = resolve(root, '.records/server-artifact');
    await mkdir(receiptDirectory, { recursive: true });
    const receiptPath = join(receiptDirectory, `a2f-${sourceManifest.commit}.json`);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
    await rm(temporaryRoot, { force: true, recursive: true });
}

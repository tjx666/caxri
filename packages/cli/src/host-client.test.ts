import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof fsPromises>()),
    readFile: readFileMock,
}));

import { discoverHostManifest, ensureHost } from './host-client';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    readFileMock.mockReset();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('Host discovery', () => {
    it('classifies a manifest removed between metadata and content reads as absent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-cli-host-discovery-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const hostDirectory = join(userDataPath, 'host');
        const manifestPath = join(hostDirectory, 'manifest.json');
        await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
        await chmod(hostDirectory, 0o700);
        await writeFile(manifestPath, '{}\n', { mode: 0o600 });
        const removed = Object.assign(new Error('manifest removed'), { code: 'ENOENT' });
        readFileMock.mockRejectedValueOnce(removed);

        await expect(discoverHostManifest(userDataPath)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('launches a replacement when an incompatible manifest belongs to a dead process', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-cli-stale-host-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const hostDirectory = join(userDataPath, 'host');
        const manifestPath = join(hostDirectory, 'manifest.json');
        await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
        await chmod(hostDirectory, 0o700);
        await writeFile(manifestPath, '{}\n', { mode: 0o600 });
        const canonicalUserDataPath = await realpath(userDataPath);
        readFileMock.mockResolvedValue(
            JSON.stringify({
                endpoint: join(hostDirectory, 'host.sock'),
                manifestVersion: 1,
                operatorToken: 'a'.repeat(64),
                pid: process.pid,
                processIdentity: 'b'.repeat(32),
                profileId: createHash('sha256')
                    .update(canonicalUserDataPath)
                    .digest('hex')
                    .slice(0, 24),
                protocolVersion: 1,
                startedAt: 1,
                version: '1.0.0',
            }),
        );
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('dead process'), { code: 'ESRCH' });
        });

        await expect(
            ensureHost(
                userDataPath,
                { executable: join(directory, 'missing-electron'), entryPath: '/app/host.js' },
                100,
            ),
        ).rejects.toMatchObject({
            code: 'UNAVAILABLE',
            message: 'Caxri Host process failed to launch',
        });
    });
});

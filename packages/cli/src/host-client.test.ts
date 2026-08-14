import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof fsPromises>()),
    readFile: readFileMock,
}));

import { discoverHostManifest } from './host-client';

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
});

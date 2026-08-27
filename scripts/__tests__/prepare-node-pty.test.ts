import { chmod, link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { finishNodePtyPreparation, prepareNodePtySpawnHelper } from '../prepare-node-pty';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { force: true, recursive: true })));
});

describe('prepareNodePtySpawnHelper', () => {
    it('replaces a non-executable hard link without mutating the shared store inode', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-node-pty-helper-'));
        temporaryDirectories.push(directory);
        const storeHelper = join(directory, 'store-spawn-helper');
        const packageRoot = join(directory, 'node-pty');
        const packageHelper = join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper');
        await mkdir(join(packageRoot, 'prebuilds', 'darwin-arm64'), { recursive: true });
        await writeFile(storeHelper, 'helper');
        await chmod(storeHelper, 0o644);
        await link(storeHelper, packageHelper);

        await expect(
            prepareNodePtySpawnHelper({ arch: 'arm64', packageRoot, platform: 'darwin' }),
        ).resolves.toEqual({ changed: true });
        expect((await stat(packageHelper)).mode & 0o777).toBe(0o755);
        expect((await stat(storeHelper)).mode & 0o777).toBe(0o644);
        await expect(
            prepareNodePtySpawnHelper({ arch: 'arm64', packageRoot, platform: 'darwin' }),
        ).resolves.toEqual({ changed: false });
    });

    it('is a no-op outside macOS', async () => {
        await expect(
            prepareNodePtySpawnHelper({
                arch: 'x64',
                packageRoot: '/not-needed',
                platform: 'linux',
            }),
        ).resolves.toEqual({ changed: false });
    });

    it('flushes the readiness receipt before exiting the one-shot process', async () => {
        const events: string[] = [];
        const exit = new Error('exit');

        const completion = finishNodePtyPreparation({
            exit: (code) => {
                events.push(`exit:${code}`);
                throw exit;
            },
            write: (_output, callback) => {
                events.push('write');
                queueMicrotask(() => {
                    events.push('flushed');
                    callback();
                });
            },
        });

        await expect(completion).rejects.toBe(exit);
        expect(events).toEqual(['write', 'flushed', 'exit:0']);
    });
});

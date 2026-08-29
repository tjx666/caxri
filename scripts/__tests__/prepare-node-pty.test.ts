import { chmod, link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareNodePtySpawnHelper } from '../prepare-node-pty';

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
        const nativeModule = join(packageRoot, 'prebuilds', 'darwin-arm64', 'pty.node');
        const packageHelper = join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper');
        await mkdir(join(packageRoot, 'prebuilds', 'darwin-arm64'), { recursive: true });
        await writeFile(storeHelper, 'helper');
        await writeFile(nativeModule, 'module');
        await chmod(storeHelper, 0o644);
        await link(storeHelper, packageHelper);

        await expect(
            prepareNodePtySpawnHelper(
                { arch: 'arm64', packageRoot, platform: 'darwin' },
                (candidate) => candidate === nativeModule,
            ),
        ).resolves.toEqual({ changed: true });
        expect((await stat(packageHelper)).mode & 0o777).toBe(0o755);
        expect((await stat(storeHelper)).mode & 0o777).toBe(0o644);
        await expect(
            prepareNodePtySpawnHelper(
                { arch: 'arm64', packageRoot, platform: 'darwin' },
                (candidate) => candidate === nativeModule,
            ),
        ).resolves.toEqual({ changed: false });
    });

    it('prepares the compiled helper selected before a packaged prebuild', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-node-pty-compiled-helper-'));
        temporaryDirectories.push(directory);
        const packageRoot = join(directory, 'node-pty');
        const compiledModule = join(packageRoot, 'build', 'Release', 'pty.node');
        const compiledHelper = join(packageRoot, 'build', 'Release', 'spawn-helper');
        const prebuiltHelper = join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper');
        await Promise.all([
            mkdir(join(packageRoot, 'build', 'Release'), { recursive: true }),
            mkdir(join(packageRoot, 'prebuilds', 'darwin-arm64'), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(compiledHelper, 'compiled helper'),
            writeFile(prebuiltHelper, 'prebuilt helper'),
            writeFile(compiledModule, 'compiled module'),
            writeFile(
                join(packageRoot, 'prebuilds', 'darwin-arm64', 'pty.node'),
                'prebuilt module',
            ),
        ]);
        await Promise.all([chmod(compiledHelper, 0o644), chmod(prebuiltHelper, 0o644)]);

        await expect(
            prepareNodePtySpawnHelper(
                { arch: 'arm64', packageRoot, platform: 'darwin' },
                (candidate) => candidate === compiledModule,
            ),
        ).resolves.toEqual({ changed: true });
        expect((await stat(compiledHelper)).mode & 0o777).toBe(0o755);
        expect((await stat(prebuiltHelper)).mode & 0o777).toBe(0o644);
    });

    it('ignores an orphan helper whose native module cannot be loaded', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-node-pty-orphan-helper-'));
        temporaryDirectories.push(directory);
        const packageRoot = join(directory, 'node-pty');
        const invalidCompiledModule = join(packageRoot, 'build', 'Release', 'pty.node');
        const orphanHelper = join(packageRoot, 'build', 'Release', 'spawn-helper');
        const prebuiltDirectory = join(packageRoot, 'prebuilds', 'darwin-arm64');
        const prebuiltModule = join(prebuiltDirectory, 'pty.node');
        const prebuiltHelper = join(prebuiltDirectory, 'spawn-helper');
        await Promise.all([
            mkdir(join(packageRoot, 'build', 'Release'), { recursive: true }),
            mkdir(prebuiltDirectory, { recursive: true }),
        ]);
        await Promise.all([
            writeFile(orphanHelper, 'orphan helper'),
            writeFile(invalidCompiledModule, 'invalid compiled module'),
            writeFile(prebuiltHelper, 'prebuilt helper'),
            writeFile(prebuiltModule, 'prebuilt module'),
        ]);
        await Promise.all([chmod(orphanHelper, 0o644), chmod(prebuiltHelper, 0o644)]);

        await expect(
            prepareNodePtySpawnHelper(
                { arch: 'arm64', packageRoot, platform: 'darwin' },
                (candidate) => candidate === prebuiltModule,
            ),
        ).resolves.toEqual({ changed: true });
        expect((await stat(orphanHelper)).mode & 0o777).toBe(0o644);
        expect((await stat(prebuiltHelper)).mode & 0o777).toBe(0o755);
    });

    it('fails clearly when no supported helper exists', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-node-pty-missing-helper-'));
        temporaryDirectories.push(directory);

        await expect(
            prepareNodePtySpawnHelper(
                {
                    arch: 'arm64',
                    packageRoot: directory,
                    platform: 'darwin',
                },
                () => false,
            ),
        ).rejects.toThrow(
            'No node-pty native module and spawn-helper pair exists in a supported location',
        );
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
});

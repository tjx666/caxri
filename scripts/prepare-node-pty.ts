import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

export interface NodePtyPreparationOptions {
    arch: string;
    packageRoot: string;
    platform: NodeJS.Platform;
}

export interface NodePtyPreparationResult {
    changed: boolean;
}

type NativeModuleProbe = (path: string) => boolean;

const packageRequire = createRequire(import.meta.url);

/**
 * Pnpm's content-addressed store can expose package files through hard links. Replace the local helper inode before
 * changing its mode so a CI checkout never mutates the shared runner cache used by another job.
 */
async function ensureExecutableCopy(path: string): Promise<NodePtyPreparationResult> {
    const before = await lstat(path);
    if (before.isSymbolicLink())
        throw new Error('node-pty spawn-helper must not be a symbolic link');
    if (!before.isFile()) throw new Error('node-pty spawn-helper is not a regular file');
    if ((before.mode & 0o111) !== 0) return { changed: false };

    const replacement = `${path}.caxri-${process.pid}-${randomUUID()}`;
    try {
        await copyFile(path, replacement);
        await chmod(replacement, (before.mode & 0o777) | 0o111);
        await rename(replacement, path);
    } finally {
        await rm(replacement, { force: true });
    }
    if (((await lstat(path)).mode & 0o111) === 0)
        throw new Error('node-pty spawn-helper is not executable after preparation');
    return { changed: true };
}

const canLoadNativeModule: NativeModuleProbe = (path) => {
    try {
        packageRequire(path);
        return true;
    } catch {
        return false;
    }
};

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
}

export async function prepareNodePtySpawnHelper(
    options: NodePtyPreparationOptions,
    isNativeModuleLoadable: NativeModuleProbe = canLoadNativeModule,
): Promise<NodePtyPreparationResult> {
    if (options.platform !== 'darwin') return { changed: false };
    /**
     * Node-pty 1.1.0 loads native artifacts in this order, so prepare the helper beside the selected module instead of
     * assuming every install retained a packaged prebuild:
     * https://github.com/microsoft/node-pty/blob/1.1.0/src/utils.ts
     */
    const candidateDirectories = [
        join(options.packageRoot, 'build', 'Release'),
        join(options.packageRoot, 'build', 'Debug'),
        join(options.packageRoot, 'prebuilds', `darwin-${options.arch}`),
    ];
    for (const candidateDirectory of candidateDirectories) {
        if (!isNativeModuleLoadable(join(candidateDirectory, 'pty.node'))) continue;
        try {
            // eslint-disable-next-line no-await-in-loop -- preparation must follow the first loadable native candidate.
            return await ensureExecutableCopy(join(candidateDirectory, 'spawn-helper'));
        } catch (error: unknown) {
            if (errorCode(error) !== 'ENOENT') throw error;
            throw new Error('The selected node-pty native module has no sibling spawn-helper', {
                cause: error,
            });
        }
    }
    throw new Error(
        'No node-pty native module and spawn-helper pair exists in a supported location',
    );
}

async function main(): Promise<void> {
    const packageRoot = dirname(packageRequire.resolve('node-pty/package.json'));
    await prepareNodePtySpawnHelper({
        arch: process.arch,
        packageRoot,
        platform: process.platform,
    });
    process.stdout.write('node-pty spawn helper ready\n');
}

if (import.meta.main) await main();

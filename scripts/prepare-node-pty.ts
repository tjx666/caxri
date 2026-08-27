import { randomUUID } from 'node:crypto';
import { chmod, copyFile, rename, rm, stat } from 'node:fs/promises';
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

/**
 * Pnpm's content-addressed store can expose package files through hard links. Replace the local helper inode before
 * changing its mode so a CI checkout never mutates the shared runner cache used by another job.
 */
async function ensureExecutableCopy(path: string): Promise<NodePtyPreparationResult> {
    const before = await stat(path);
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
    if (((await stat(path)).mode & 0o111) === 0)
        throw new Error('node-pty spawn-helper is not executable after preparation');
    return { changed: true };
}

export async function prepareNodePtySpawnHelper(
    options: NodePtyPreparationOptions,
): Promise<NodePtyPreparationResult> {
    if (options.platform !== 'darwin') return { changed: false };
    const helper = join(options.packageRoot, 'prebuilds', `darwin-${options.arch}`, 'spawn-helper');
    return ensureExecutableCopy(helper);
}

async function main(): Promise<void> {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve('node-pty/package.json'));
    await prepareNodePtySpawnHelper({
        arch: process.arch,
        packageRoot,
        platform: process.platform,
    });
    process.stdout.write('node-pty spawn helper ready\n');
}

if (import.meta.main) await main();

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

interface NodePtyCompletionOperations {
    exit: (code: number) => never;
    write: (output: string, callback: (error?: Error | null) => void) => void;
}

const defaultCompletionOperations: NodePtyCompletionOperations = {
    exit: (code) => process.exit(code),
    write: (output, callback) => process.stdout.write(output, callback),
};

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

/**
 * Flushes the one-shot command receipt before forcing a clean exit. A detached Bun invocation printed the receipt but
 * retained a runtime handle until CI's 25-minute deadline, so natural event-loop termination is not reliable here. See
 * https://github.com/tjx666/caxri/actions/runs/33041294162.
 */
export async function finishNodePtyPreparation(
    operations: NodePtyCompletionOperations = defaultCompletionOperations,
): Promise<never> {
    await new Promise<void>((resolve, reject) => {
        operations.write('node-pty spawn helper ready\n', (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
    return operations.exit(0);
}

async function main(): Promise<void> {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve('node-pty/package.json'));
    await prepareNodePtySpawnHelper({
        arch: process.arch,
        packageRoot,
        platform: process.platform,
    });
    await finishNodePtyPreparation();
}

if (import.meta.main) await main();

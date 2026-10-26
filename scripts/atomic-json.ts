import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

interface AtomicFileIdentity {
    dev: number;
    ino: number;
}

export interface AtomicJsonWriteOptions {
    afterRename?: (path: string, identity: AtomicFileIdentity) => Promise<void> | void;
    beforeRename?: (temporaryPath: string, identity: AtomicFileIdentity) => Promise<void> | void;
    ensureParent?: boolean;
    mode?: number;
}

async function assertFileIdentity(
    path: string,
    expected: AtomicFileIdentity,
    phase: 'after' | 'before',
): Promise<void> {
    const metadata = await lstat(path);
    if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.dev !== expected.dev ||
        metadata.ino !== expected.ino
    ) {
        throw new Error(`Atomic JSON temporary file identity changed ${phase} rename`);
    }
}

/**
 * Publishes formatted JSON through an exclusive, no-follow, synced temporary file. Callers with stronger path-identity
 * contracts can revalidate immediately before and after the rename.
 */
export async function writeJsonAtomic(
    path: string,
    value: unknown,
    options: AtomicJsonWriteOptions = {},
): Promise<void> {
    await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * Publishes arbitrary text or bytes with the same exclusive, no-follow, synced temporary file and identity checks as
 * `writeJsonAtomic`. This and `writeJsonAtomic` are the only sanctioned write-then-rename publishers in repository
 * tooling; `scripts/__tests__/atomic-write-contract.test.ts` rejects an inline pair.
 */
export async function writeTextAtomic(
    path: string,
    content: string | Uint8Array,
    options: AtomicJsonWriteOptions = {},
): Promise<void> {
    const parent = dirname(path);
    if (options.ensureParent) await mkdir(parent, { recursive: true });
    const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        const handle = await open(
            temporary,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            options.mode ?? 0o666,
        );
        try {
            await handle.writeFile(content);
            await handle.sync();
            const opened = await handle.stat();
            const identity = { dev: opened.dev, ino: opened.ino };
            await assertFileIdentity(temporary, identity, 'before');
            await options.beforeRename?.(temporary, identity);
            await assertFileIdentity(temporary, identity, 'before');
            await rename(temporary, path);
            await assertFileIdentity(path, identity, 'after');
            await options.afterRename?.(path, identity);
        } finally {
            await handle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

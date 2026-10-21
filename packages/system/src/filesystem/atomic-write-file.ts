import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * How much of a replacement is forced to stable storage before it is reported as written.
 *
 * - `durable`: fsync the temporary file before the rename and the containing directory after it, so neither the content
 *   nor the new directory entry is lost on power failure. Use for files the user owns or that cannot be rebuilt.
 * - `file`: fsync the file only. The content is complete if the new name survives, but the rename itself may roll back.
 * - `none`: no fsync. Readers still never see a partial file, but a crash may lose the write. Use for rebuildable caches.
 */
export type AtomicWriteDurability = 'durable' | 'file' | 'none';

export interface AtomicWriteFileOptions {
    /**
     * Flush level; see {@link AtomicWriteDurability}.
     */
    durability: AtomicWriteDurability;
    /**
     * Reapplies `mode` with `fchmod` after creating the temporary file. `open` narrows its mode by the process umask,
     * which is right for a fresh Server-owned file but would silently tighten preserved user permission bits.
     */
    exactMode?: boolean;
    /**
     * Permission bits for the new file, narrowed by the umask unless `exactMode` is set. Defaults to `0o600`.
     */
    mode?: number;
    /**
     * Overrides the exclusive temporary path. It must be in the same directory as the target so the rename stays on one
     * filesystem. Defaults to `<path>.<uuid>.tmp`.
     */
    temporaryPath?: string;
}

/**
 * Replaces `path` with `data` through an exclusive same-directory temporary file and a rename, so a reader or a crash
 * never observes a partial file. The rename replaces the final directory entry itself, so a symlink at `path` becomes a
 * standalone regular file; callers that must preserve links resolve the target first. The temporary file is removed on
 * every failure, and the parent directory is created when missing.
 */
export async function atomicWriteFile(
    path: string,
    data: string | Uint8Array,
    options: AtomicWriteFileOptions,
): Promise<void> {
    const directory = dirname(path);
    const mode = options.mode ?? 0o600;
    await mkdir(directory, { recursive: true });
    const temporary = options.temporaryPath ?? `${path}.${randomUUID()}.tmp`;
    // Exclusive create comes first and outside the cleanup scope: if the path is taken, the file belongs to someone else.
    const file = await open(temporary, 'wx', mode);
    try {
        try {
            if (options.exactMode) await file.chmod(mode);
            await file.writeFile(data, typeof data === 'string' ? 'utf8' : undefined);
            if (options.durability !== 'none') await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
        if (options.durability === 'durable') {
            const directoryHandle = await open(directory, constants.O_RDONLY);
            try {
                await directoryHandle.sync();
            } finally {
                await directoryHandle.close();
            }
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

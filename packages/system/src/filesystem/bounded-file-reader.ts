import type { Buffer } from 'node:buffer';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';

import { CaxriError } from '@caxri/protocol';

import { readFileHandleUpTo } from './read-file-handle-up-to.js';

type OpenRegularFile = (path: string, flags: number) => Promise<FileHandle>;

export interface BoundedRegularFileReadOptions {
    /**
     * Test seam for mutating the opened file before the bounded read begins.
     */
    beforeRead?: () => Promise<void>;
    capacityMessage?: string;
    /**
     * Runs against the opened handle's `fstat` metadata before the shared regular-file and size checks. A caller throws
     * here to reject with its own policy error (an owner or permission-mode check), or records the identity the read
     * belongs to (a revision) so it can attach that identity to a later rejection.
     */
    inspect?: (metadata: Stats) => void;
    notRegularFileMessage?: string;
    openFile?: OpenRegularFile;
    /**
     * `follow` (the default) resolves a final symlink, since user-selected themes and provider-owned configuration
     * commonly point at dotfile-managed regular files. `nofollow` adds `O_NOFOLLOW`, so a final symlink fails the open
     * with `ELOOP` instead of redirecting a private store to a file the caller never wrote.
     */
    symlinks?: 'follow' | 'nofollow';
}

function capacityError(maxBytes: number, message?: string): CaxriError {
    return new CaxriError('CAPACITY', message ?? `File exceeds the ${maxBytes} byte safety limit`);
}

/**
 * Reads bytes from one opened regular-file handle without trusting a pathname's pre-read metadata.
 *
 * The open always carries `O_NONBLOCK`: a plain read-only open of a FIFO planted at the path blocks until a writer
 * appears, which would park a libuv thread and the awaiting caller indefinitely. With it the open returns at once and
 * the `fstat` check below rejects the FIFO. The opened handle is `fstat`-validated as a regular file, rejected when
 * that size already exceeds the cap, and capped before parser input is exposed. The extra byte detects a file that
 * grows after it is opened while keeping parser input bounded.
 *
 * Every rejection the reader itself decides is a `CaxriError` (`IO` for a non-regular file, `CAPACITY` for an oversized
 * one); filesystem faults such as `ENOENT` or `ELOOP` propagate unchanged, so a caller can still tell a missing file
 * from a refused one.
 */
export async function readBoundedRegularFile(
    path: string,
    maxBytes: number,
    options: BoundedRegularFileReadOptions = {},
): Promise<Buffer> {
    const openFile = options.openFile ?? open;
    const symlinkFlag = options.symlinks === 'nofollow' ? constants.O_NOFOLLOW : 0;
    const file = await openFile(path, constants.O_RDONLY | constants.O_NONBLOCK | symlinkFlag);
    try {
        const stats = await file.stat();
        options.inspect?.(stats);
        if (!stats.isFile())
            throw new CaxriError(
                'IO',
                options.notRegularFileMessage ?? 'Path is not a regular file',
            );
        if (stats.size > maxBytes) throw capacityError(maxBytes, options.capacityMessage);
        await options.beforeRead?.();

        const buffer = await readFileHandleUpTo(file, stats.size, maxBytes);
        if (buffer.length > maxBytes) throw capacityError(maxBytes, options.capacityMessage);
        return buffer;
    } finally {
        await file.close();
    }
}

export async function readBoundedRegularFileText(
    path: string,
    maxBytes: number,
    options: BoundedRegularFileReadOptions = {},
): Promise<string> {
    return (await readBoundedRegularFile(path, maxBytes, options)).toString('utf8');
}

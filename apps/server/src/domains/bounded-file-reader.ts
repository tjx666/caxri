import { Buffer } from 'node:buffer';
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';

import { CaxriError } from '@caxri/protocol';

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

/**
 * Reads an opened file from offset 0, returning at most `maxBytes + 1` bytes so a caller detects an oversized file by
 * length. The buffer starts at the `fstat` size the caller already holds instead of the cap: V8 counts every Buffer as
 * external memory, and allocating the whole cap (2 MiB for Project search) per file kept a search Worker in
 * back-to-back full GCs while it read thousands of small files. A file that grew after its `fstat` (or one that reports
 * size 0, like procfs) continues into a cap-sized buffer, so the result is the same as reading into the cap.
 *
 * `apps/server/src/domains/files/project-search-worker.ts` keeps its own copy of this loop: that Worker imports only
 * Node builtins at runtime, because its tests run the TypeScript source directly as a Worker.
 */
export async function readFileHandleUpTo(
    file: Pick<FileHandle, 'read'>,
    sizeHint: number,
    maxBytes: number,
): Promise<Buffer> {
    let buffer = Buffer.allocUnsafe(Math.min(Math.max(0, sizeHint), maxBytes) + 1);
    let bytesRead = 0;
    for (;;) {
        if (bytesRead === buffer.length) {
            if (buffer.length > maxBytes) break;
            const grown = Buffer.allocUnsafe(maxBytes + 1);
            buffer.copy(grown, 0, 0, bytesRead);
            buffer = grown;
        }
        // Each read's offset depends on the bytes already read, so the reads are inherently sequential.
        // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
        const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
    }
    return buffer.subarray(0, bytesRead);
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

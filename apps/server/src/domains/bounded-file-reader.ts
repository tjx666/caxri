import { Buffer } from 'node:buffer';
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
    openFile?: OpenRegularFile;
}

function capacityError(maxBytes: number, message?: string): CaxriError {
    return new CaxriError('CAPACITY', message ?? `File exceeds the ${maxBytes} byte safety limit`);
}

/**
 * Reads bytes from one opened regular-file handle without trusting a pathname's pre-read metadata.
 *
 * Final symlinks are intentionally followed because user-selected themes and provider-owned configuration commonly
 * point at dotfile-managed regular files. The opened handle is still `fstat`-validated as a regular file, rejected when
 * that size already exceeds the cap, read with `O_NONBLOCK`, and capped before parser input is exposed. The extra byte
 * detects a file that grows after it is opened while keeping parser input bounded.
 */
export async function readBoundedRegularFile(
    path: string,
    maxBytes: number,
    options: BoundedRegularFileReadOptions = {},
): Promise<Buffer> {
    const openFile = options.openFile ?? open;
    const file = await openFile(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const stats = await file.stat();
        if (!stats.isFile()) throw new CaxriError('IO', 'Path is not a regular file');
        if (stats.size > maxBytes) throw capacityError(maxBytes, options.capacityMessage);
        await options.beforeRead?.();

        const buffer = Buffer.allocUnsafe(maxBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            // Each read's offset depends on the byte count already read, so the reads are
            // inherently sequential and cannot be batched with Promise.all.
            // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
            const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > maxBytes) throw capacityError(maxBytes, options.capacityMessage);
        return buffer.subarray(0, bytesRead);
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

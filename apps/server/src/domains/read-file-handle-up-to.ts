import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';

/**
 * Reads an opened file from offset 0, returning at most `maxBytes + 1` bytes so a caller detects an oversized file by
 * length. The buffer starts at the `fstat` size the caller already holds instead of the cap: V8 counts every Buffer as
 * external memory, and allocating the whole cap (2 MiB for Project search) per file kept a search Worker in
 * back-to-back full GCs while it read thousands of small files. A file that grew after its `fstat` (or one that reports
 * size 0, like procfs) continues into a cap-sized buffer, so the result is the same as reading into the cap.
 *
 * Twin of `packages/system/src/filesystem/read-file-handle-up-to.ts` (keep identical), which backs the shared
 * `readBoundedRegularFile`. This module imports only Node builtins: `files/project-search-worker.ts` imports it by its
 * `.ts` path, because the Worker's tests run that TypeScript source directly as a Worker.
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

import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

import { CaxriError } from '../shared/ipc/errors';

export type OpenRegularFile = (path: string, flags: number) => Promise<FileHandle>;

export interface BoundedRegularFileReadOptions {
    /** Test seam for mutating the opened file before the bounded read begins. */
    beforeRead?: () => Promise<void>;
    capacityMessage?: string;
    openFile?: OpenRegularFile;
}

/**
 * Reads text from one opened regular-file handle without trusting a pathname's pre-read metadata.
 *
 * The extra byte detects a file that grows after it is opened while keeping parser input bounded.
 */
export async function readBoundedRegularFileText(
    path: string,
    maxBytes: number,
    options: BoundedRegularFileReadOptions = {},
): Promise<string> {
    const openFile = options.openFile ?? open;
    const file = await openFile(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
        if (!(await file.stat()).isFile()) throw new CaxriError('IO', 'Path is not a regular file');
        await options.beforeRead?.();

        const buffer = Buffer.allocUnsafe(maxBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > maxBytes)
            throw new CaxriError(
                'CAPACITY',
                options.capacityMessage ?? `File exceeds the ${maxBytes} byte safety limit`,
            );
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await file.close();
    }
}

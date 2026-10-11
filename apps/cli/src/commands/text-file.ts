import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { CaxriError } from '@caxri/protocol';

/**
 * Reads a long text argument (a delegation task, an Inbox report) from a file, because a single argv entry is capped
 * far below what these carry. Refuses a symlink (`O_NOFOLLOW`) and anything but a regular file, and reads one byte past
 * the limit so a file that grew after `stat` is still rejected instead of silently truncated.
 */
export async function readBoundedTextFile(
    path: string,
    maxBytes: number,
    label: string,
): Promise<string> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await file.stat();
        const limit = `${maxBytes / 1_024} KiB`;
        if (!info.isFile() || info.size > maxBytes)
            throw new CaxriError(
                'VALIDATION',
                `${label} must be a regular file of at most ${limit}`,
            );
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maxBytes) throw new CaxriError('VALIDATION', `${label} exceeds ${limit}`);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await file.close();
    }
}

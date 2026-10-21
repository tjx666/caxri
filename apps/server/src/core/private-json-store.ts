import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';

import { CaxriError, isCaxriError } from '@caxri/protocol';
import { atomicWriteFile, readBoundedRegularFile } from '@caxri/system';

export interface PrivateJsonMessages {
    malformed: string;
    notPrivate: string;
    oversized: string;
    wrongOwner: string;
}

export function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

/**
 * Reads a bounded owner-only regular JSON file without following a final symlink.
 *
 * The shared bounded reader owns the open (`O_NOFOLLOW` plus `O_NONBLOCK`, so a FIFO planted at the store path is
 * refused rather than blocking Server Core on its writer). Owner and permission policy runs on the opened handle's
 * metadata before any byte is read, and the reader's oversize rejection, including growth after the open, keeps this
 * store's own `VALIDATION` wording.
 */
export async function readPrivateJsonFile(options: {
    maxBytes: number;
    messages: PrivateJsonMessages;
    path: string;
}): Promise<unknown> {
    let source: Buffer;
    try {
        source = await readBoundedRegularFile(options.path, options.maxBytes, {
            inspect: (metadata) => {
                if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
                    throw new CaxriError('PATH_DENIED', options.messages.notPrivate);
                if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
                    throw new CaxriError('PATH_DENIED', options.messages.wrongOwner);
            },
            symlinks: 'nofollow',
        });
    } catch (error) {
        if (fileSystemCode(error) === 'ELOOP')
            throw new CaxriError('PATH_DENIED', options.messages.notPrivate);
        if (isCaxriError(error) && error.code === 'CAPACITY')
            throw new CaxriError('VALIDATION', options.messages.oversized);
        throw error;
    }
    try {
        return JSON.parse(source.toString('utf8')) as unknown;
    } catch {
        throw new CaxriError('VALIDATION', options.messages.malformed);
    }
}

/**
 * Atomically replaces one private JSON file and fsyncs both the file and containing directory.
 */
export async function replacePrivateJsonFile(options: {
    directory: string;
    path: string;
    random?: (bytes: number) => Uint8Array;
    temporaryPrefix: string;
    value: unknown;
}): Promise<void> {
    const random = options.random ?? randomBytes;
    const suffix = Buffer.from(random(12)).toString('hex');
    await atomicWriteFile(options.path, `${JSON.stringify(options.value)}\n`, {
        durability: 'durable',
        temporaryPath: join(options.directory, `${options.temporaryPrefix}${suffix}.tmp`),
    });
}

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { CaxriError } from '@caxri/protocol';

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
 */
export async function readPrivateJsonFile(options: {
    maxBytes: number;
    messages: PrivateJsonMessages;
    path: string;
}): Promise<unknown> {
    let handle: FileHandle;
    try {
        handle = await open(options.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if (fileSystemCode(error) === 'ELOOP')
            throw new CaxriError('PATH_DENIED', options.messages.notPrivate);
        throw error;
    }
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
            throw new CaxriError('PATH_DENIED', options.messages.notPrivate);
        if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
            throw new CaxriError('PATH_DENIED', options.messages.wrongOwner);
        if (metadata.size > options.maxBytes)
            throw new CaxriError('VALIDATION', options.messages.oversized);

        const source = Buffer.allocUnsafe(options.maxBytes + 1);
        let offset = 0;
        while (offset < source.length) {
            // eslint-disable-next-line no-await-in-loop -- One file descriptor must fill one bounded buffer sequentially.
            const { bytesRead } = await handle.read(source, offset, source.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset > options.maxBytes)
            throw new CaxriError('VALIDATION', options.messages.oversized);
        try {
            return JSON.parse(source.subarray(0, offset).toString('utf8')) as unknown;
        } catch {
            throw new CaxriError('VALIDATION', options.messages.malformed);
        }
    } finally {
        await handle.close();
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
    const temporary = join(
        options.directory,
        `${options.temporaryPrefix}${Buffer.from(random(12)).toString('hex')}.tmp`,
    );
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(options.value)}\n`, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, options.path);
        const directoryHandle = await open(options.directory, 'r');
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

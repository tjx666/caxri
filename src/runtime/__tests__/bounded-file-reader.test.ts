import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { readBoundedRegularFileText } from '../bounded-file-reader';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTemporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

/**
 * Test seam for the `read`-loop accumulation. Serves file content back in caller-controlled chunk sizes so
 * short/partial reads exercise the same sequential-offset loop as a real slow filesystem.
 */
function createChunkedFileHandle(content: Buffer, chunkSizes: number[]): FileHandle {
    let chunkIndex = 0;
    return {
        stat: () =>
            Promise.resolve({ isFile: () => true }) as unknown as ReturnType<FileHandle['stat']>,
        read: (buffer: Buffer, offset: number, length: number, filePosition: number) => {
            const chunkSize = chunkSizes[chunkIndex] ?? 0;
            chunkIndex += 1;
            const bytesToCopy = Math.max(
                0,
                Math.min(chunkSize, length, content.length - filePosition),
            );
            content.copy(buffer, offset, filePosition, filePosition + bytesToCopy);
            return Promise.resolve({ bytesRead: bytesToCopy, buffer });
        },
        close: () => Promise.resolve(),
    } as unknown as FileHandle;
}

describe('readBoundedRegularFileText', () => {
    it('reads a normal regular file within the byte cap', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-normal-');
        const path = join(directory, 'file.txt');
        await writeFile(path, 'hello world', 'utf8');

        await expect(readBoundedRegularFileText(path, 1024)).resolves.toBe('hello world');
    });

    it('rejects a symlink pointing at a non-regular target', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-symlink-');
        const targetDirectory = join(directory, 'target-dir');
        await mkdir(targetDirectory);
        const path = join(directory, 'link-to-dir');
        await symlink(targetDirectory, path);

        await expect(readBoundedRegularFileText(path, 1024)).rejects.toMatchObject({
            code: 'IO',
        } satisfies Partial<CaxriError>);
    });

    it('rejects a direct non-regular file', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-nonregular-');

        await expect(readBoundedRegularFileText(directory, 1024)).rejects.toMatchObject({
            code: 'IO',
        } satisfies Partial<CaxriError>);
    });

    it('rejects a file that exceeds the byte cap with CAPACITY', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-capacity-');
        const path = join(directory, 'file.txt');
        await writeFile(path, 'x'.repeat(10), 'utf8');

        await expect(readBoundedRegularFileText(path, 9)).rejects.toMatchObject({
            code: 'CAPACITY',
        } satisfies Partial<CaxriError>);
    });

    it('uses a custom capacity message when provided', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-capacity-message-');
        const path = join(directory, 'file.txt');
        await writeFile(path, 'x'.repeat(10), 'utf8');

        await expect(
            readBoundedRegularFileText(path, 9, { capacityMessage: 'Too big for this reader' }),
        ).rejects.toMatchObject({
            code: 'CAPACITY',
            message: 'Too big for this reader',
        } satisfies Partial<CaxriError>);
    });

    it('accepts a file exactly at the byte cap', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-at-limit-');
        const path = join(directory, 'file.txt');
        const content = 'x'.repeat(9);
        await writeFile(path, content, 'utf8');

        await expect(readBoundedRegularFileText(path, 9)).resolves.toBe(content);
    });

    it('reassembles content delivered across multiple short reads', async () => {
        const content = Buffer.from('hello world', 'utf8');
        const openFile = () => Promise.resolve(createChunkedFileHandle(content, [3, 4, 4]));

        await expect(readBoundedRegularFileText('unused-path', 1024, { openFile })).resolves.toBe(
            'hello world',
        );
    });

    it('bounds a file that grows past the cap while the handle is open', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-growth-');
        const path = join(directory, 'file.txt');
        await writeFile(path, 'x'.repeat(5), 'utf8');

        await expect(
            readBoundedRegularFileText(path, 9, {
                beforeRead: async () => {
                    await appendFile(path, 'x'.repeat(20), 'utf8');
                },
            }),
        ).rejects.toMatchObject({ code: 'CAPACITY' } satisfies Partial<CaxriError>);
    });
});

import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { CaxriError } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import {
    readBoundedRegularFile,
    readBoundedRegularFileText,
    readFileHandleUpTo,
} from '../bounded-file-reader';

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
            Promise.resolve({ isFile: () => true, size: content.length }) as unknown as ReturnType<
                FileHandle['stat']
            >,
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

    it('rejects from fstat size before reading file bytes', async () => {
        const openFile = () =>
            Promise.resolve({
                stat: () =>
                    Promise.resolve({ isFile: () => true, size: 100 }) as unknown as ReturnType<
                        FileHandle['stat']
                    >,
                read: () => {
                    throw new Error('bounded reader must not read after an oversized fstat');
                },
                close: () => Promise.resolve(),
            } as unknown as FileHandle);

        await expect(readBoundedRegularFile('unused-path', 10, { openFile })).rejects.toMatchObject(
            {
                code: 'CAPACITY',
            } satisfies Partial<CaxriError>,
        );
    });

    it('returns the raw bytes so callers can inspect them before decoding', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-bytes-');
        const path = join(directory, 'file.bin');
        const content = Buffer.from([0, 1, 2, 3]);
        await writeFile(path, content);

        await expect(readBoundedRegularFile(path, 1024)).resolves.toEqual(content);
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

    /**
     * A plain read-only open of a FIFO blocks until a writer appears, parking a libuv thread and the caller with it.
     * `O_NONBLOCK` returns the open at once so the `fstat` check can refuse the FIFO instead.
     */
    it.skipIf(process.platform === 'win32')(
        'refuses a FIFO at the path, or behind a final symlink, without waiting for a writer',
        async () => {
            const directory = await makeTemporaryDirectory('caxri-bounded-read-fifo-');
            const fifo = join(directory, 'planted.json');
            await execFileAsync('mkfifo', [fifo]);
            const link = join(directory, 'link.json');
            await symlink(fifo, link);

            await expect(
                readBoundedRegularFileText(fifo, 1024, { notRegularFileMessage: 'Not a file' }),
            ).rejects.toMatchObject({
                code: 'IO',
                message: 'Not a file',
            } satisfies Partial<CaxriError>);
            await expect(readBoundedRegularFileText(link, 1024)).rejects.toMatchObject({
                code: 'IO',
            } satisfies Partial<CaxriError>);
        },
        2_000,
    );

    it('refuses a final symlink under the nofollow policy while still reading a regular file', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-nofollow-');
        const target = join(directory, 'target.json');
        await writeFile(target, '{}', 'utf8');
        const link = join(directory, 'link.json');
        await symlink(target, link);

        await expect(
            readBoundedRegularFileText(link, 1024, { symlinks: 'nofollow' }),
        ).rejects.toMatchObject({ code: 'ELOOP' });
        await expect(
            readBoundedRegularFileText(target, 1024, { symlinks: 'nofollow' }),
        ).resolves.toBe('{}');
        await expect(readBoundedRegularFileText(link, 1024)).resolves.toBe('{}');
    });

    it('hands the opened metadata to inspect before the shared checks, letting it reject first', async () => {
        const directory = await makeTemporaryDirectory('caxri-bounded-read-inspect-');
        const path = join(directory, 'file.txt');
        await writeFile(path, 'x'.repeat(10), 'utf8');
        const inspected: number[] = [];

        await expect(
            readBoundedRegularFileText(path, 9, {
                inspect: (metadata) => {
                    inspected.push(metadata.size);
                },
            }),
        ).rejects.toMatchObject({ code: 'CAPACITY' } satisfies Partial<CaxriError>);
        expect(inspected).toEqual([10]);

        const policy = new Error('caller policy');
        await expect(
            readBoundedRegularFileText(path, 9, {
                inspect: () => {
                    throw policy;
                },
            }),
        ).rejects.toBe(policy);
    });
});

/**
 * Serves `content` in reads of at most `chunkBytes` and records the size of every buffer it was asked to fill.
 */
function recordingHandle(content: string, chunkBytes = Infinity) {
    const bytes = Buffer.from(content);
    const bufferSizes: number[] = [];
    const file: Pick<FileHandle, 'read'> = {
        read: ((buffer: Buffer, offset: number, length: number, position: number) => {
            bufferSizes.push(buffer.length);
            const count = Math.max(0, Math.min(length, chunkBytes, bytes.length - position));
            bytes.copy(buffer, offset, position, position + count);
            return Promise.resolve({ buffer, bytesRead: count });
        }) as FileHandle['read'],
    };
    return { bufferSizes, file };
}

describe('readFileHandleUpTo', () => {
    it('sizes the buffer from the stat size instead of the cap', async () => {
        const { bufferSizes, file } = recordingHandle('hello', 2);
        const result = await readFileHandleUpTo(file, 5, 2 * 1024 * 1024);
        expect(result.toString()).toBe('hello');
        expect(new Set(bufferSizes)).toEqual(new Set([6]));
    });

    it('keeps reading a file that grew after its stat, up to one byte past the cap', async () => {
        const grown = recordingHandle('hello world');
        expect((await readFileHandleUpTo(grown.file, 5, 1024)).toString()).toBe('hello world');
        expect(grown.bufferSizes.at(-1)).toBe(1025);

        const oversized = recordingHandle('x'.repeat(50));
        expect(await readFileHandleUpTo(oversized.file, 5, 20)).toHaveLength(21);
    });

    it('reads a file whose stat reports size 0', async () => {
        const { file } = recordingHandle('procfs');
        expect((await readFileHandleUpTo(file, 0, 64)).toString()).toBe('procfs');
    });
});

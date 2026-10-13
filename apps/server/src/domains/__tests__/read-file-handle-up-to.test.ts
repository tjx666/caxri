import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { readFileHandleUpTo } from '../read-file-handle-up-to';

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

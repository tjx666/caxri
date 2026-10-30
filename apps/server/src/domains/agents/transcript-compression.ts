import type { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';

/**
 * Codex compresses a cold rollout in place to `<rollout>.jsonl.zst` (one Zstandard stream of the exact JSONL bytes) and
 * materializes it back to `.jsonl` before appending to it again, so a compressed transcript is never written to.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/rollout/src/compression.rs
 */
export const COMPRESSED_TRANSCRIPT_SUFFIX = '.zst';

/**
 * Decompressed bytes one read of a compressed transcript may produce. Far above a real rollout, so it only bounds a
 * pathological or hostile file; the decompressed bytes stay in memory one chunk at a time and never reach disk.
 */
const MAX_DECOMPRESSED_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

export function isCompressedTranscriptPath(path: string): boolean {
    return path.toLowerCase().endsWith(COMPRESSED_TRANSCRIPT_SUFFIX);
}

/**
 * The compressed transcript decompressed past {@link MAX_DECOMPRESSED_TRANSCRIPT_BYTES}.
 */
export class DecompressLimitError extends Error {
    constructor() {
        super('Compressed transcript exceeds the decompression limit');
        this.name = 'DecompressLimitError';
    }
}

/**
 * Streams the decompressed bytes of an opened compressed transcript from its start. A corrupt or truncated stream
 * throws the decompressor's error; passing `limit` throws {@link DecompressLimitError}. The caller keeps ownership of
 * `handle` and closes it.
 *
 * @yields {Buffer} The next decompressed chunk.
 */
export async function* decompressTranscript(
    handle: FileHandle,
    limit = MAX_DECOMPRESSED_TRANSCRIPT_BYTES,
): AsyncGenerator<Buffer> {
    const source = handle.createReadStream({ start: 0, autoClose: false });
    const decompress = createZstdDecompress();
    source.on('error', (error) => decompress.destroy(error));
    source.pipe(decompress);
    let total = 0;
    try {
        for await (const chunk of decompress as AsyncIterable<Buffer>) {
            total += chunk.length;
            if (total > limit) throw new DecompressLimitError();
            yield chunk;
        }
    } finally {
        source.unpipe(decompress);
        decompress.destroy();
        source.destroy();
    }
}

/**
 * The positional reads a bounded transcript head reader needs, satisfied by a plain `FileHandle`.
 */
export interface TranscriptByteReader {
    read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
}

/**
 * Serves a compressed transcript's decompressed bytes through {@link TranscriptByteReader}. A Zstandard stream cannot
 * seek, so each read must continue where the previous one stopped; a head read always does. Closing also closes
 * `handle`.
 */
export function sequentialDecompressedReader(handle: FileHandle): TranscriptByteReader {
    const chunks = decompressTranscript(handle);
    let pending: Buffer | undefined;
    let position = 0;
    let isDone = false;
    return {
        async read(buffer, offset, length, at) {
            if (at !== position) throw new Error('A compressed transcript is read sequentially');
            while (!isDone && !pending?.length) {
                // eslint-disable-next-line no-await-in-loop -- decompressed chunks arrive in order
                const next = await chunks.next();
                if (next.done) isDone = true;
                else pending = next.value;
            }
            if (!pending) return { bytesRead: 0 };
            const bytesRead = pending.copy(buffer, offset, 0, Math.min(length, pending.length));
            pending = pending.subarray(bytesRead);
            position += bytesRead;
            return { bytesRead };
        },
        async close() {
            try {
                await chunks.return(undefined);
            } finally {
                await handle.close();
            }
        },
    };
}

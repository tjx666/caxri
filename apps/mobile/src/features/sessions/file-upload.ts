import { mobileFileChunkCount } from '@caxri/protocol';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Standard padded base64 of `bytes`. Hermes has no `Buffer` and no `Uint8Array.prototype.toBase64`, and `btoa` would
 * need a binary string of every chunk first.
 */
export const encodeBase64 = (bytes: Uint8Array): string => {
    let output = '';
    let index = 0;
    for (; index + 2 < bytes.length; index += 3) {
        const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
        output +=
            ALPHABET[value >> 18] +
            ALPHABET[(value >> 12) & 63] +
            ALPHABET[(value >> 6) & 63] +
            ALPHABET[value & 63];
    }
    const left = bytes.length - index;
    if (left === 1) {
        const value = bytes[index] << 16;
        output += `${ALPHABET[value >> 18]}${ALPHABET[(value >> 12) & 63]}==`;
    } else if (left === 2) {
        const value = (bytes[index] << 16) | (bytes[index + 1] << 8);
        output += `${ALPHABET[value >> 18]}${ALPHABET[(value >> 12) & 63]}${ALPHABET[(value >> 6) & 63]}=`;
    }
    return output;
};

/**
 * Chunks kept in flight at once. The Server serializes them, so more only hides the round trip through the relay.
 */
const UPLOAD_CONCURRENCY = 4;

/**
 * Uploads a file of `size` bytes chunk by chunk, several at a time, and resolves the Server path once the last chunk
 * landed, or `undefined` when `isCancelled` stopped it. A failed chunk stops the rest and rejects.
 */
export async function uploadFileChunks({
    isCancelled,
    onProgress,
    readChunk,
    sendChunk,
    size,
}: {
    isCancelled: () => boolean;
    onProgress: (progress: number) => void;
    /**
     * The base64 of chunk `index`, read when it is about to be sent so a large file never sits in memory whole.
     */
    readChunk: (index: number) => string;
    sendChunk: (index: number, chunk: string) => Promise<{ ready: boolean; path?: string }>;
    size: number;
}): Promise<string | undefined> {
    const count = mobileFileChunkCount(size);
    let next = 0;
    let done = 0;
    let isStopped = false;
    let path: string | undefined;
    const worker = async (): Promise<void> => {
        while (!isStopped && next < count) {
            if (isCancelled()) {
                isStopped = true;
                return;
            }
            const index = next;
            next += 1;
            try {
                // eslint-disable-next-line no-await-in-loop -- Each worker sends its chunks one after another.
                const result = await sendChunk(index, readChunk(index));
                if (result.ready && result.path) path = result.path;
            } catch (error) {
                isStopped = true;
                throw error;
            }
            done += 1;
            onProgress(done / count);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, count) }, async () => worker()),
    );
    if (done < count) return undefined;
    // The chunk that completes the file answers with its path, whichever worker sent it.
    if (path === undefined) throw new Error('The computer did not confirm the uploaded file.');
    return path;
}

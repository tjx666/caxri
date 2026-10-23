/**
 * How a capped body read ended: the body finished (`end`), the caller had what it needed (`stopped`), or more than the
 * byte cap arrived (`limit`).
 */
export type CappedBodyEnd = 'end' | 'stopped' | 'limit';

/**
 * Streams a response body chunk by chunk and cancels the rest once `maxBytes` is exceeded or `onChunk` returns `true`,
 * so a huge, endless, or chunked body without `content-length` never buffers in Main. `onChunk` sees every chunk that
 * arrived, including the one that crossed the cap.
 */
export async function readCappedBody(
    response: Response,
    maxBytes: number,
    onChunk: (chunk: Uint8Array) => boolean | void,
): Promise<CappedBodyEnd> {
    const reader = response.body?.getReader();
    if (!reader) return 'end';
    let bytes = 0;
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- a body stream yields its chunks one read at a time
            const { done, value } = await reader.read();
            if (done) return 'end';
            bytes += value.byteLength;
            if (onChunk(value) === true) return 'stopped';
            if (bytes > maxBytes) return 'limit';
        }
    } finally {
        void reader.cancel().catch(() => {});
    }
}

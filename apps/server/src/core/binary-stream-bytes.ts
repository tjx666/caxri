import { Buffer } from 'node:buffer';

import type { RawData } from 'ws';

export function rawBinaryBytes(data: RawData): Uint8Array {
    if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(Buffer.concat(data));
}

export function combineBinaryChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
    const combined = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined;
}

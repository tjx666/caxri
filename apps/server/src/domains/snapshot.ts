import { Buffer } from 'node:buffer';

export const MAX_SNAPSHOT_LINES = 2_000;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function countLines(payload: string): number {
    let lineCount = 1;
    for (let index = 0; index < payload.length; index += 1)
        if (payload.codePointAt(index) === 10) lineCount += 1;
    return lineCount;
}

function keepNewestLines(payload: string): string {
    let remainingBreaks = countLines(payload) - MAX_SNAPSHOT_LINES;
    if (remainingBreaks <= 0) return payload;
    let start = 0;
    while (remainingBreaks > 0) {
        start = payload.indexOf('\n', start) + 1;
        remainingBreaks -= 1;
    }
    return payload.slice(start);
}

export function boundSnapshot(payload: string): {
    payload: string;
    lineCount: number;
    byteCount: number;
} {
    let bounded = keepNewestLines(payload);
    let byteCount = Buffer.byteLength(bounded, 'utf8');
    if (byteCount > MAX_SNAPSHOT_BYTES) {
        const buffer = Buffer.from(bounded, 'utf8');
        let start = buffer.length - MAX_SNAPSHOT_BYTES;
        while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
        bounded = buffer.subarray(start).toString('utf8');
        byteCount = buffer.length - start;
    }
    return {
        payload: bounded,
        lineCount: Math.min(countLines(bounded), MAX_SNAPSHOT_LINES),
        byteCount,
    };
}

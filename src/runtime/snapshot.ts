import { Buffer } from 'node:buffer';

export const MAX_SNAPSHOT_LINES = 2_000;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export function boundSnapshot(payload: string): {
    payload: string;
    lineCount: number;
    byteCount: number;
} {
    const lines = payload.split('\n');
    let bounded =
        lines.length > MAX_SNAPSHOT_LINES ? lines.slice(-MAX_SNAPSHOT_LINES).join('\n') : payload;
    if (Buffer.byteLength(bounded, 'utf8') > MAX_SNAPSHOT_BYTES) {
        const buffer = Buffer.from(bounded, 'utf8');
        bounded = buffer
            .subarray(buffer.length - MAX_SNAPSHOT_BYTES)
            .toString('utf8')
            .replace(/^\uFFFD/, '');
    }
    return {
        payload: bounded,
        lineCount: Math.min(bounded.split('\n').length, MAX_SNAPSHOT_LINES),
        byteCount: Buffer.byteLength(bounded, 'utf8'),
    };
}

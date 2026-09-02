import { Buffer } from 'node:buffer';

import type { AgentTranscriptLocation } from './transcript-security';
import { openSafeAgentTranscript } from './transcript-security';

const MAX_TRANSCRIPT_SCAN_BYTES_PER_READ = 4 * 1024 * 1024;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

export interface TranscriptScanCursor {
    /**
     * Byte offset of the first unconsumed transcript byte; scans resume here on the next poll.
     */
    offset: number;
}

export interface TranscriptScanOptions {
    /**
     * Invoked once when the transcript shrank below the cursor (the provider rewrote it), so the caller can drop any
     * state derived from bytes that no longer exist before the rescan from byte zero starts.
     */
    onReset?: () => void;
}

/**
 * Incrementally feeds complete transcript lines to `scanLine`, reading only the bytes appended since the cursor's last
 * visit. Frequent background polls therefore never rescan a multi-megabyte transcript. The final line may lack a
 * trailing newline; it is scanned without consuming so a later append re-delivers it complete. A missing or unreadable
 * transcript is a normal capability miss and leaves the cursor untouched.
 */
export async function scanTranscriptLines(
    location: AgentTranscriptLocation,
    cursor: TranscriptScanCursor,
    scanLine: (line: string) => void,
    options: TranscriptScanOptions = {},
): Promise<void> {
    try {
        const opened = await openSafeAgentTranscript(location);
        if (!opened) return;
        const { handle, stats } = opened;
        try {
            if (stats.size < cursor.offset) {
                cursor.offset = 0;
                options.onReset?.();
            }
            const chunk = Buffer.allocUnsafe(TRANSCRIPT_READ_CHUNK_BYTES);
            let scanned = 0;
            let remainder = Buffer.alloc(0);
            while (
                cursor.offset + remainder.length < stats.size &&
                scanned < MAX_TRANSCRIPT_SCAN_BYTES_PER_READ
            ) {
                // eslint-disable-next-line no-await-in-loop -- chunks of one file must be read sequentially
                const { bytesRead } = await handle.read(
                    chunk,
                    0,
                    chunk.length,
                    cursor.offset + remainder.length,
                );
                if (bytesRead <= 0) break;
                scanned += bytesRead;
                const combined = Buffer.concat([remainder, chunk.subarray(0, bytesRead)]);
                const lastNewline = combined.lastIndexOf(0x0a);
                if (lastNewline === -1) {
                    remainder = combined;
                    continue;
                }
                for (const line of combined.subarray(0, lastNewline).toString('utf8').split('\n'))
                    scanLine(line);
                remainder = combined.subarray(lastNewline + 1);
                cursor.offset += lastNewline + 1;
            }
            scanLine(remainder.toString('utf8'));
        } finally {
            await handle.close();
        }
    } catch {
        /**
         * A missing or unreadable transcript is a normal capability miss; keep any previously scanned state.
         */
    }
}

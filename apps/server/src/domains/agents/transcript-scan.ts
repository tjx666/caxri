import { Buffer } from 'node:buffer';

import {
    DecompressLimitError,
    decompressTranscript,
    isCompressedTranscriptPath,
} from './transcript-compression';
import type {
    AgentTranscriptLocation,
    SafeOpenedAgentTranscript,
    TranscriptScanFailureReason,
} from './transcript-security';
import { openSafeAgentTranscript } from './transcript-security';

const MAX_TRANSCRIPT_SCAN_BYTES_PER_READ = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_CATCHUP_PASSES = 16;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

export interface TranscriptScanCursor {
    /**
     * Byte offset of the first unconsumed transcript byte; scans resume here on the next poll.
     */
    offset: number;
    /**
     * A record exceeded the per-pass limit; discard its remainder before scanning later records.
     */
    skippingOversizedLine?: boolean;
}

export interface TranscriptScanOptions {
    /**
     * Reports why a pass produced nothing, distinguishing a routine capability miss (`missing`, before an Agent's first
     * line) from a security rejection (`symlinkRejected`, `hardlinkRejected`, `identityMismatch`, `structureRejected`)
     * and an IO failure (`openFailed`, `readFailed`). Optional and purely additive: omitting it reproduces the exact
     * prior silent-failure behavior.
     */
    onFailure?: (reason: TranscriptScanFailureReason) => void;
    /**
     * Invoked once when the transcript shrank below the cursor (the provider rewrote it), so the caller can drop any
     * state derived from bytes that no longer exist before the rescan from byte zero starts.
     */
    onReset?: () => void;
    /**
     * Stops {@link scanTranscriptToEnd} before its next pass once aborted, so a cancelled request does not finish a read
     * of up to 64 MiB. The cursor stays where the last completed pass left it, and the scan returns rather than throws:
     * whatever it delivered is partial, so a caller that passes a signal checks it after the scan.
     */
    signal?: AbortSignal;
    /**
     * Withholds a final line that has no trailing newline yet. A caller that persists what it scanned (the Session
     * search index) would otherwise ingest that line now and again once an append completes it.
     */
    completeLinesOnly?: boolean;
}

/**
 * Feeds every line of a compressed transcript in one streaming pass. Such a file is never appended to (Codex
 * materializes it back to `.jsonl` first), so its cursor is either zero or the compressed size, and its last line is
 * complete even without a trailing newline. A line past the per-pass limit is skipped like an oversized plain record. A
 * corrupt stream or one past the decompression bound keeps the lines already delivered and reports why it stopped.
 */
async function scanCompressedTranscript(
    { handle, stats }: SafeOpenedAgentTranscript,
    cursor: TranscriptScanCursor,
    scanLine: (line: string) => void,
    options: TranscriptScanOptions,
): Promise<number> {
    if (cursor.offset >= stats.size) return stats.size;
    if (cursor.offset > 0) options.onReset?.();
    cursor.offset = 0;
    cursor.skippingOversizedLine = false;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let isSkipping = false;
    const take = (bytes: Buffer) => {
        if (isSkipping) return;
        pending.push(bytes);
        pendingBytes += bytes.length;
        if (pendingBytes < MAX_TRANSCRIPT_SCAN_BYTES_PER_READ) return;
        pending = [];
        pendingBytes = 0;
        isSkipping = true;
    };
    const flush = () => {
        if (!isSkipping) scanLine(Buffer.concat(pending).toString('utf8'));
        pending = [];
        pendingBytes = 0;
        isSkipping = false;
    };
    try {
        for await (const chunk of decompressTranscript(handle)) {
            let start = 0;
            for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
                take(chunk.subarray(start, end));
                flush();
                start = end + 1;
            }
            if (start < chunk.length) take(chunk.subarray(start));
        }
        if (pendingBytes > 0) flush();
    } catch (error) {
        options.onFailure?.(
            error instanceof DecompressLimitError ? 'decompressLimit' : 'decompressFailed',
        );
    }
    // Marked read either way: an unchanged file would fail the same way, and a new identity rescans it from the start.
    cursor.offset = stats.size;
    return stats.size;
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
): Promise<number | undefined> {
    try {
        const opened = await openSafeAgentTranscript(location, options.onFailure);
        if (!opened) return;
        const { handle, stats } = opened;
        try {
            if (isCompressedTranscriptPath(opened.path))
                return await scanCompressedTranscript(opened, cursor, scanLine, options);
            if (stats.size < cursor.offset) {
                cursor.offset = 0;
                cursor.skippingOversizedLine = false;
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
                let next = chunk.subarray(0, bytesRead);
                if (cursor.skippingOversizedLine) {
                    const firstNewline = next.indexOf(0x0a);
                    if (firstNewline === -1) {
                        cursor.offset += bytesRead;
                        continue;
                    }
                    cursor.offset += firstNewline + 1;
                    cursor.skippingOversizedLine = false;
                    next = next.subarray(firstNewline + 1);
                }
                const combined = Buffer.concat([remainder, next]);
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
            if (remainder.length >= MAX_TRANSCRIPT_SCAN_BYTES_PER_READ) {
                // A single unbounded JSONL record must not pin the cursor before every later record.
                cursor.offset += remainder.length;
                cursor.skippingOversizedLine = true;
                return stats.size;
            }
            if (!options.completeLinesOnly) scanLine(remainder.toString('utf8'));
            return stats.size;
        } finally {
            await handle.close();
        }
    } catch {
        /**
         * `openSafeAgentTranscript` already reported its own rejection reason (or found nothing to report, a routine
         * capability miss); reaching this catch instead means the file opened but a later read of its bytes failed.
         * Either way, keep any previously scanned state: a missing or unreadable transcript is not fatal to the
         * caller.
         */
        options.onFailure?.('readFailed');
        return undefined;
    }
}

/**
 * Catches an existing transcript up to its size at the start of this read, with a 64 MiB total read budget. Yielding
 * between 4 MiB passes keeps a long first visit from monopolizing Server Core. Waiting for the next UI poll after each
 * pass would make a report near the end of a long conversation appear minutes late. An aborted `options.signal` ends
 * the read at the next pass boundary.
 */
export async function scanTranscriptToEnd(
    location: AgentTranscriptLocation,
    cursor: TranscriptScanCursor,
    scanLine: (line: string) => void,
    options: TranscriptScanOptions = {},
): Promise<void> {
    let targetSize: number | undefined;
    for (let pass = 0; pass < MAX_TRANSCRIPT_CATCHUP_PASSES; pass++) {
        if (options.signal?.aborted) return;
        const previousOffset = cursor.offset;
        // eslint-disable-next-line no-await-in-loop -- each pass resumes at the cursor advanced by the previous pass
        const size = await scanTranscriptLines(location, cursor, scanLine, options);
        if (size === undefined) return;
        if (size < previousOffset) {
            // A rewritten transcript reset the cursor during this pass; its new tail still belongs to this read.
            targetSize = size;
        } else if (cursor.offset <= previousOffset) {
            return;
        }
        targetSize ??= size;
        if (cursor.offset >= targetSize) return;
        // eslint-disable-next-line no-await-in-loop -- yield between bounded passes without waiting for the next UI poll
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

import { compactInlineMediaPayloads } from './inline-media';

/**
 * Bounded line reads of one provider transcript for `external-conversation-parsers.ts`, which never reads a whole
 * transcript: only a bounded head, and for Claude a bounded tail.
 */

/**
 * What a head read could not deliver, so a conversation it leaves without a folder or prompt is reported by cause.
 */
export interface HeadReadOutcome {
    /**
     * The record the head budget cut off still ran past the straddling-record caps and was skipped.
     */
    hasDroppedRecord: boolean;
}

/**
 * Every field this module needs sits at the start of a transcript. A Codex rollout opens with a ~20 KiB `session_meta`
 * record and injected AGENTS.md / environment blocks, which put the first real prompt past 100 KiB in practice, so the
 * head budget is larger than one chunk. Reading stops as soon as the needed fields are found.
 */
const HEAD_CHUNK_BYTES = 64 * 1024;
export const HEAD_BUDGET_BYTES = 256 * 1024;
/**
 * A record the head budget cuts off is read to its end with inline media collapsed while it buffers, because the first
 * prompt often carries a pasted screenshot that alone outweighs the budget. Without media such a record stays small;
 * these caps only bound a pathological line.
 */
const STRADDLING_RECORD_MAX_BYTES = 64 * 1024 * 1024;
const STRADDLING_RECORD_MAX_CHARS = 256 * 1024;

/**
 * Yields complete lines from `[start, end)` of a regular file without following a final symlink. A range that starts
 * mid-file drops its leading partial line. A trailing partial line is read on toward `lineLimit` (EOF for a head read)
 * to its newline, collapsing inline media as it buffers, and is dropped when it ends past the straddling-record caps.
 *
 * @yields {Record<string, unknown>} Each line that parses as a JSON object.
 */
export async function* readJsonRecords(
    handle: FileHandle,
    start: number,
    end: number,
    lineLimit = end,
    outcome?: HeadReadOutcome,
): AsyncGenerator<Record<string, unknown>> {
    const buffer = Buffer.alloc(HEAD_CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let position = start;
    let pending = '';
    let isFragmentPending = start > 0;
    const parse = (line: string) => {
        try {
            const value: unknown = JSON.parse(line);
            return value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : undefined;
        } catch {
            return;
        }
    };
    while (position < end) {
        // Each read continues where the previous one stopped, so the reads are inherently sequential.
        // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
        const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(HEAD_CHUNK_BYTES, end - position),
            position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        if (isFragmentPending && lines.length > 0) {
            lines.shift();
            isFragmentPending = false;
        }
        for (const line of lines) {
            const record = parse(line);
            if (record) yield record;
        }
    }
    if (isFragmentPending || !pending) return;
    const straddleLimit = Math.min(lineLimit, end + STRADDLING_RECORD_MAX_BYTES);
    pending = compactInlineMediaPayloads(pending);
    while (position < straddleLimit && pending.length <= STRADDLING_RECORD_MAX_CHARS) {
        // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
        const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(HEAD_CHUNK_BYTES, straddleLimit - position),
            position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
        pending = compactInlineMediaPayloads(
            pending + decoder.write(buffer.subarray(0, bytesRead)),
        );
        const newline = pending.indexOf('\n');
        if (newline !== -1) {
            const record = parse(pending.slice(0, newline));
            if (record) yield record;
            return;
        }
    }
    // A final line without a newline is complete only at EOF.
    if (position < lineLimit || pending.length > STRADDLING_RECORD_MAX_CHARS) {
        if (outcome) outcome.hasDroppedRecord = true;
        return;
    }
    const record = parse(pending + decoder.end());
    if (record) yield record;
}

/**
 * The head of a transcript: its first `HEAD_BUDGET_BYTES`, plus the rest of the record that budget cuts off.
 */
export function readHeadRecords(handle: FileHandle, size: number, outcome?: HeadReadOutcome) {
    return readJsonRecords(handle, 0, Math.min(size, HEAD_BUDGET_BYTES), size, outcome);
}

export async function openTranscript(path: string) {
    let handle: FileHandle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch {
        return;
    }
    try {
        const metadata = await handle.stat();
        if (metadata.isFile()) return { handle, size: metadata.size };
    } catch {
        // An entry that cannot be inspected is closed and skipped like a non-file one.
    }
    try {
        await handle.close();
    } catch {
        // Nothing more to release.
    }
    return;
}

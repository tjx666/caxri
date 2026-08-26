import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    LogQueryParams as LogQueryParameters,
    LogQueryRecord,
    LogQueryResult,
} from '@caxri/protocol';
import { CaxriError, logQueryRecordSchema } from '@caxri/protocol';
import { isSecretKey, redactLogValue } from '@caxri/system';

const LOG_NAME = /^(?:host|main|runtime)\.jsonl(?:\.1)?$/u;
const DEFAULT_MAXIMUM_RECORDS = 4_096;
const DEFAULT_MAXIMUM_BYTES_PER_FILE = 512 * 1024;

interface Cursor {
    id: string;
    timestamp: string;
}

function cursorFor(record: LogQueryRecord): string {
    return `${record.timestamp}\t${record.id}`;
}

function parseCursor(value: string): Cursor {
    const separator = value.indexOf('\t');
    const timestamp = value.slice(0, separator);
    const id = value.slice(separator + 1);
    if (separator < 1 || !Number.isFinite(Date.parse(timestamp)) || !/^[0-9a-f]{24}$/u.test(id))
        throw new CaxriError('VALIDATION', 'Log cursor is invalid');
    return { timestamp, id };
}

function compareCursor(left: Cursor, right: Cursor): number {
    return left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id);
}

function recordCursor(record: LogQueryRecord): Cursor {
    return { timestamp: record.timestamp, id: record.id };
}

async function readSuffix(path: string, maximumBytes: number): Promise<string> {
    let file: FileHandle | undefined;
    try {
        file = await open(path, 'r');
        const metadata = await file.stat();
        const offset = Math.max(0, metadata.size - maximumBytes);
        const buffer = Buffer.alloc(Math.min(metadata.size, maximumBytes));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        let source = buffer.subarray(0, bytesRead).toString('utf8');
        if (offset > 0) {
            const firstNewline = source.indexOf('\n');
            source = firstNewline === -1 ? '' : source.slice(firstNewline + 1);
        }
        return source;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
    } finally {
        await file?.close();
    }
}

/**
 * Read-time defense in depth mirroring the logger's write-time `safeFields`: a line written to the log directory
 * outside `StructuredLogger` must not surface secret-like values through `logs.query`.
 */
function safeQueryFields(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            isSecretKey(key)
                ? '[REDACTED]'
                : typeof entry === 'string'
                  ? redactLogValue(entry)
                  : entry,
        ]),
    );
}

function safeRecord(line: string): LogQueryRecord | undefined {
    try {
        const value = JSON.parse(line) as Record<string, unknown>;
        /**
         * Content identity survives the logger's atomic `.jsonl` to `.jsonl.1` rotation.
         */
        const id = createHash('sha256').update(line).digest('hex').slice(0, 24);
        return logQueryRecordSchema.parse({
            id,
            timestamp: value.timestamp,
            process: value.process,
            level: value.level,
            event: value.event,
            correlationId: value.correlationId,
            durationMs: value.durationMs,
            fields: safeQueryFields(value.fields),
        });
    } catch {
        return undefined;
    }
}

function isRecordMatching(record: LogQueryRecord, query: LogQueryParameters): boolean {
    return (
        (!query.since || record.timestamp >= query.since) &&
        (!query.process || record.process === query.process) &&
        (!query.level || record.level === query.level) &&
        (!query.event || record.event === query.event) &&
        (!query.correlationId || record.correlationId === query.correlationId)
    );
}

/**
 * Reads only bounded log suffixes and projects the structured record model, re-applying secret redaction to fields.
 */
export class LogQueryService {
    private readonly maximumBytesPerFile: number;
    private readonly maximumRecords: number;

    constructor(
        private readonly directory: string,
        options: { maximumBytesPerFile?: number; maximumRecords?: number } = {},
    ) {
        this.maximumBytesPerFile = options.maximumBytesPerFile ?? DEFAULT_MAXIMUM_BYTES_PER_FILE;
        this.maximumRecords = options.maximumRecords ?? DEFAULT_MAXIMUM_RECORDS;
    }

    async query(query: LogQueryParameters): Promise<LogQueryResult> {
        let names: string[];
        try {
            names = (await readdir(this.directory))
                .filter((name) => LOG_NAME.test(name))
                .toSorted((left, right) => left.localeCompare(right));
        } catch {
            names = [];
        }
        const sources = await Promise.all(
            names.map(async (name) => ({
                name,
                source: await readSuffix(join(this.directory, name), this.maximumBytesPerFile),
            })),
        );
        let records = sources.flatMap(({ source }) =>
            source.split('\n').flatMap((line) => {
                if (!line) return [];
                const record = safeRecord(line);
                return record ? [record] : [];
            }),
        );
        records.sort((left, right) => compareCursor(recordCursor(left), recordCursor(right)));
        const dropped = Math.max(0, records.length - this.maximumRecords);
        if (dropped > 0) records = records.slice(dropped);

        const after = query.afterCursor ? parseCursor(query.afterCursor) : undefined;
        const earliest = records[0] ? recordCursor(records[0]) : undefined;
        const isGap = Boolean(after && earliest && compareCursor(after, earliest) < 0);
        const afterRecords = after
            ? records.filter((record) => compareCursor(recordCursor(record), after) > 0)
            : records;
        const matching = afterRecords.filter((record) => isRecordMatching(record, query));
        const selected = after ? matching.slice(0, query.limit) : matching.slice(-query.limit);
        const isTruncated = dropped > 0 || matching.length > selected.length;
        const cursorRecord =
            after && matching.length > selected.length
                ? selected.at(-1)
                : (afterRecords.at(-1) ?? records.at(-1));
        return {
            records: selected,
            ...(cursorRecord && { nextCursor: cursorFor(cursorRecord) }),
            gap: isGap,
            truncated: isTruncated,
        };
    }
}

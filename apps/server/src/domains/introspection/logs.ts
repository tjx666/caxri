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
import {
    CaxriError,
    logProcesses,
    logQueryContextSchema,
    logQueryFailureSchema,
    logQueryRecordSchema,
} from '@caxri/protocol';
import { isSecretKey, redactLogValue } from '@caxri/system';

/**
 * Matches every rotated generation the logger keeps (`.jsonl`, `.jsonl.1`, `.jsonl.2`, ...). Matching any numeric
 * suffix rather than hardcoding `StructuredLogger`'s current `MAX_LOG_GENERATIONS` bound keeps this query complete if
 * that retention window changes without both sites needing to move together.
 */
const LOG_NAME = new RegExp(String.raw`^(?:${logProcesses.join('|')})\.jsonl(?:\.\d+)?$`, 'u');
const DEFAULT_MAXIMUM_RECORDS = 4_096;
const DEFAULT_MAXIMUM_BYTES_PER_FILE = 512 * 1024;
/**
 * A cursorless query narrowed by a correlation ID scans a wider suffix: the default window holds only minutes of a busy
 * `debug` profile, which is too short to find an older Session's records after the fact.
 */
const DEFAULT_MAXIMUM_BYTES_PER_FILE_FOR_ID_FILTER = 4 * 1024 * 1024;
/**
 * Same shape the logger's `normalizeObservationContext` accepts when writing.
 */
const OBSERVATION_ID = /^[A-Za-z0-9][\w.:-]{0,199}$/u;

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

/**
 * Read-time defense in depth mirroring the logger's write-time normalization: keep only known keys whose values are
 * opaque identifiers, so a line written outside `StructuredLogger` cannot surface a path or prose through `context`.
 */
function safeQueryContext(value: unknown): LogQueryRecord['context'] {
    if (typeof value !== 'object' || value === null) return undefined;
    const entries = Object.entries(value).filter(([key, entry]) =>
        key === 'processId'
            ? typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0
            : key in logQueryContextSchema.shape &&
              typeof entry === 'string' &&
              OBSERVATION_ID.test(entry),
    );
    if (entries.length === 0) return undefined;
    return logQueryContextSchema.parse(Object.fromEntries(entries));
}

/**
 * A malformed `failure` drops only itself; the record stays readable. The nested `context` is never copied.
 */
function safeQueryFailure(value: unknown): LogQueryRecord['failure'] {
    if (typeof value !== 'object' || value === null) return undefined;
    const parsed = logQueryFailureSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const { reason, remediation, owner, phase } = parsed.data;
    const identifiers = [reason, remediation, owner, phase, parsed.data.code ?? 'X'];
    return identifiers.every((entry) => /^[\w.-]+$/u.test(entry)) ? parsed.data : undefined;
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
            context: safeQueryContext(value.context),
            failure: safeQueryFailure(value.failure),
            fields: safeQueryFields(value.fields),
        });
    } catch {
        return undefined;
    }
}

function addUniqueRecords(records: Map<string, LogQueryRecord>, source: string): void {
    for (const line of source.split('\n')) {
        if (!line) continue;
        const record = safeRecord(line);
        if (record) records.set(record.id, record);
    }
}

type IdFilter = 'projectId' | 'sessionId' | 'terminalId';
const ID_FILTERS: readonly IdFilter[] = ['projectId', 'sessionId', 'terminalId'];

function hasIdFilter(query: LogQueryParameters): boolean {
    return [query.projectId, query.sessionId, query.terminalId, query.traceId].some(Boolean);
}

/**
 * Lifecycle events carry IDs only in `fields`; request and Git records carry them only in `context`. Match both.
 */
function isIdMatching(record: LogQueryRecord, key: IdFilter, expected: string): boolean {
    return record.context?.[key] === expected || record.fields?.[key] === expected;
}

function isRecordMatching(record: LogQueryRecord, query: LogQueryParameters): boolean {
    return (
        ID_FILTERS.every((key) => !query[key] || isIdMatching(record, key, query[key])) &&
        (!query.traceId || record.context?.traceId === query.traceId) &&
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
    private readonly maximumBytesForIdFilter: number;
    private readonly maximumRecords: number;

    constructor(
        private readonly directory: string,
        options: {
            maximumBytesForIdFilter?: number;
            maximumBytesPerFile?: number;
            maximumRecords?: number;
        } = {},
    ) {
        this.maximumBytesForIdFilter =
            options.maximumBytesForIdFilter ?? DEFAULT_MAXIMUM_BYTES_PER_FILE_FOR_ID_FILTER;
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
        const isIdFiltered = hasIdFilter(query) && !query.afterCursor;
        const maximumBytes = isIdFiltered
            ? Math.max(this.maximumBytesPerFile, this.maximumBytesForIdFilter)
            : this.maximumBytesPerFile;
        const sources = await Promise.all(
            names.map(async (name) => ({
                name,
                source: await readSuffix(join(this.directory, name), maximumBytes),
            })),
        );
        const uniqueRecords = new Map<string, LogQueryRecord>();
        for (const { source } of sources) addUniqueRecords(uniqueRecords, source);
        let records = uniqueRecords.values().toArray();
        // Filter before the cap so an ID-filtered query is not starved by unrelated recent records.
        if (isIdFiltered) records = records.filter((record) => isRecordMatching(record, query));
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

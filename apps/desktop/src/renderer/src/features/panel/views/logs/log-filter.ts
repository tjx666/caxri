import type { LogLevel, LogQueryRecord } from '@caxri/protocol';

/**
 * Parsed VS Code Output-panel style text filter: comma-separated patterns combined with OR, a `!` prefix excludes, and
 * double quotes protect literal commas or a leading `!` (`"a,b"`, `"!literal"`).
 */
export interface ParsedLogFilter {
    includes: string[];
    excludes: string[];
}

function splitOutsideQuotes(text: string): string[] {
    const parts: string[] = [];
    let current = '';
    let isQuoted = false;
    for (const character of text) {
        if (character === '"') isQuoted = !isQuoted;
        if (character === ',' && !isQuoted) {
            parts.push(current);
            current = '';
        } else {
            current += character;
        }
    }
    parts.push(current);
    return parts;
}

export function parseLogFilter(text: string): ParsedLogFilter {
    const includes: string[] = [];
    const excludes: string[] = [];
    for (const rawPart of splitOutsideQuotes(text)) {
        const part = rawPart.trim().toLowerCase();
        if (!part) continue;
        // The `!` operator is only recognized outside quotes; only one wrapping quote pair is stripped, after the
        // operator check, so `"!literal"` searches a literal exclamation mark and interior quotes stay searchable
        // (e.g. a `"key":"value"` pattern copied from an expanded row).
        const isExclude = part.startsWith('!');
        const body = (isExclude ? part.slice(1) : part).trim();
        const pattern = /^"(?<inner>.*)"$/su.exec(body)?.groups?.inner ?? body;
        if (!pattern) continue;
        if (isExclude) excludes.push(pattern);
        else includes.push(pattern);
    }
    return { includes, excludes };
}

/**
 * The lowercased searchable projection of a record: timestamp, process, level, event, correlation ID, and the
 * structured fields. Fields use the same pretty-printed JSON the expanded row displays, so a pattern copy-pasted from
 * the screen (e.g. `"key": "value"`) matches.
 */
export function logRecordHaystack(record: LogQueryRecord): string {
    const parts = [
        record.timestamp,
        record.process,
        record.level,
        record.event,
        record.correlationId ?? '',
        record.fields ? JSON.stringify(record.fields, undefined, 2) : '',
    ];
    return parts.join(' ').toLowerCase();
}

export function isLogFilterMatch(haystack: string, filter: ParsedLogFilter): boolean {
    if (filter.excludes.some((pattern) => haystack.includes(pattern))) return false;
    if (filter.includes.length === 0) return true;
    return filter.includes.some((pattern) => haystack.includes(pattern));
}

/**
 * Applies the level toggles and text filter together, in the order the panel needs for both its record list and its "N
 * of M" count. Extracted from the panel component so the count computation is unit-testable without rendering.
 */
export function filterLogRecords<T extends LogQueryRecord>(
    records: readonly T[],
    activeLevels: readonly LogLevel[],
    filter: ParsedLogFilter,
): T[] {
    const levels = new Set(activeLevels);
    return records.filter(
        (record) => levels.has(record.level) && isLogFilterMatch(logRecordHaystack(record), filter),
    );
}

import type { LogQueryRecord } from '@shared/types';

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
        // The `!` operator is only recognized outside quotes; quotes are stripped after the operator check so
        // `"!literal"` searches for a literal exclamation mark.
        const isExclude = part.startsWith('!');
        const pattern = (isExclude ? part.slice(1) : part).trim().replaceAll('"', '');
        if (!pattern) continue;
        if (isExclude) excludes.push(pattern);
        else includes.push(pattern);
    }
    return { includes, excludes };
}

/**
 * The lowercased searchable projection of a record: timestamp, process, level, event, correlation ID, and the
 * stringified structured fields.
 */
export function logRecordHaystack(record: LogQueryRecord): string {
    const parts = [
        record.timestamp,
        record.process,
        record.level,
        record.event,
        record.correlationId ?? '',
        record.fields ? JSON.stringify(record.fields) : '',
    ];
    return parts.join(' ').toLowerCase();
}

export function isLogFilterMatch(haystack: string, filter: ParsedLogFilter): boolean {
    if (filter.excludes.some((pattern) => haystack.includes(pattern))) return false;
    if (filter.includes.length === 0) return true;
    return filter.includes.some((pattern) => haystack.includes(pattern));
}

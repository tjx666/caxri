import type { CaxriMethod } from '@caxri/protocol';

type Row = Record<string, unknown>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A short "5 minutes ago" style age for a past epoch-millisecond timestamp.
 */
export function formatRelativeTime(timestamp: number, now: number): string {
    const elapsed = now - timestamp;
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
    if (elapsed < MINUTE) return 'just now';
    const plural = (count: number, unit: string): string =>
        `${count} ${unit}${count === 1 ? '' : 's'} ago`;
    if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute');
    if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');
    if (elapsed < 30 * DAY) return plural(Math.floor(elapsed / DAY), 'day');
    return new Date(timestamp).toISOString().slice(0, 10);
}

function text(value: unknown): string {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '-';
}

/**
 * Left-aligned columns with a header row; the last column is never padded so lines carry no trailing spaces.
 */
export function formatTable(headers: readonly string[], rows: readonly string[][]): string {
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index].length)),
    );
    const line = (cells: readonly string[]): string =>
        cells
            .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index])))
            .join('  ');
    return [line(headers), ...rows.map(line)].join('\n');
}

function formatDetails(fields: ReadonlyArray<readonly [string, string]>): string {
    const width = Math.max(...fields.map(([label]) => label.length));
    return fields.map(([label, value]) => `${`${label}:`.padEnd(width + 2)}${value}`).join('\n');
}

interface RecordKind {
    empty: string;
    key: 'projects' | 'sessions' | 'terminals';
    details(row: Row, now: number): Array<readonly [string, string]>;
    headers: string[];
    cells(row: Row, now: number): string[];
}

function sessionState(row: Row): string {
    if (typeof row.archivedAt === 'number') return 'archived';
    return text(row.agentActivityState);
}

const kinds: Partial<Record<CaxriMethod, RecordKind>> = {
    'project.query': {
        empty: 'No projects yet. Add one with `caxri project add .`.',
        key: 'projects',
        headers: ['ID', 'TITLE', 'PATH'],
        cells: (row) => [text(row.id), text(row.title), text(row.rootPath)],
        details: (row) => [
            ['Title', text(row.title)],
            ['Path', text(row.rootPath)],
            ['ID', text(row.id)],
        ],
    },
    'session.query': {
        empty: 'No sessions found.',
        key: 'sessions',
        headers: ['ID', 'TITLE', 'STATE', 'LAST ACTIVE'],
        cells: (row, now) => [
            text(row.id),
            text(row.title),
            sessionState(row),
            formatRelativeTime(Number(row.sessionActivityAt), now),
        ],
        details: (row, now) => [
            ['Title', text(row.title)],
            ['State', sessionState(row)],
            ['Last active', formatRelativeTime(Number(row.sessionActivityAt), now)],
            ['Project', text(row.projectId)],
            ['ID', text(row.id)],
        ],
    },
    'terminal.query': {
        empty: 'No terminals found.',
        key: 'terminals',
        headers: ['ID', 'TITLE', 'KIND', 'STATE'],
        cells: (row) => [
            text(row.id),
            text(row.title),
            text(row.provider ?? row.kind),
            text(row.lastProcessState),
        ],
        details: (row) => [
            ['Title', text(row.title)],
            ['Kind', text(row.provider ?? row.kind)],
            ['State', text(row.lastProcessState)],
            ['Session', text(row.sessionId)],
            ['ID', text(row.id)],
        ],
    },
};

/**
 * Human rendering of the Project, Session, and Terminal queries: a table for `list`, key: value lines for `show` and
 * `current`. Returns `undefined` for any other method so the caller keeps its generic renderer. JSON mode never calls
 * this, so the machine contract is untouched.
 */
export function renderHumanRecords(
    method: CaxriMethod,
    verb: string | undefined,
    value: unknown,
    now: number,
): string | undefined {
    const kind = kinds[method];
    if (!kind || typeof value !== 'object' || value === null) return undefined;
    const rows = Reflect.get(value, kind.key) as unknown;
    if (!Array.isArray(rows)) return undefined;
    const records = rows as Row[];
    if (records.length === 0) return `${kind.empty}\n`;
    if (verb === 'list')
        return `${formatTable(
            kind.headers,
            records.map((row) => kind.cells(row, now)),
        )}\n`;
    return `${records.map((row) => formatDetails(kind.details(row, now))).join('\n\n')}\n`;
}

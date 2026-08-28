const MAX_WINDOW_MS = 30 * 60 * 1_000;
const USAGE = 'Usage: collect-macos-gpu-logs.ts --start <ISO> --end <ISO>';

function formatForLogShow(timestampMs: number, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
        minute: '2-digit',
        month: '2-digit',
        second: '2-digit',
        timeZone,
        year: 'numeric',
    }).formatToParts(timestampMs);
    const value = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

/**
 * Validates an ISO range and converts it to the local timestamp syntax accepted by `/usr/bin/log show`.
 */
export function parseMacosGpuLogWindow(
    argv: string[],
    timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone,
): { start: string; end: string } {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key || !value || !['--start', '--end'].includes(key)) throw new Error(USAGE);
        values.set(key, value);
    }
    const start = values.get('--start');
    const end = values.get('--end');
    if (!start || !end) throw new Error('Both --start and --end are required');
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
        throw new Error('The collection window must be a valid increasing ISO range');
    if (endMs - startMs > MAX_WINDOW_MS)
        throw new Error('The collection window cannot exceed 30 minutes');
    return {
        start: formatForLogShow(startMs, timeZone),
        end: formatForLogShow(endMs, timeZone),
    };
}

import type { LogEventName, PathBrowserSearchFailureReason } from '@caxri/protocol';
import { CaxriError, logEventCatalog } from '@caxri/protocol';

/**
 * Minimal write surface a structured logger exposes to `authority.ts`, matching the `logger(): X | undefined` getter
 * pattern `event-relay.ts` uses for the same reason: `mainLogger` is constructed lazily in `index.ts`, so callers pass
 * a getter rather than the logger itself.
 */
export interface PathBrowserLogger {
    write(
        level: 'debug' | 'warn',
        event: LogEventName,
        options: { durationMs: number; fields: Record<string, boolean | number | string> },
    ): void;
}

/**
 * Maps a `files.search` rejection to `PathBrowserSearchFailureReason`; see that type's doc for why `UNAVAILABLE` covers
 * two distinct situations and `CANCELLED` is unambiguous here.
 */
function classifySearchFailure(error: unknown): PathBrowserSearchFailureReason {
    if (error instanceof CaxriError) {
        if (error.code === 'UNAVAILABLE') return 'unavailable';
        if (error.code === 'IO') return 'io';
        if (error.code === 'CANCELLED') return 'disconnected';
    }
    return 'other';
}

/**
 * Records one `pathBrowser.browse` call that ran the Project-wide name search, memo hit or fresh scan, so a slow or
 * missing search engine is diagnosable from Main's own log instead of reading like an ordinary empty result. Never pass
 * the filter or a path; see issue caxri#924.
 */
export function logSearchFallback(
    logger: PathBrowserLogger | undefined,
    durationMs: number,
    fields: {
        memoHit: boolean;
        matchCount: number;
        droppedByRootCheck: number;
        displayedCount: number;
        truncated: boolean;
        canceled: boolean;
    },
): void {
    logger?.write('debug', logEventCatalog.pathBrowser.searchFallback, { durationMs, fields });
}

/**
 * Records why the Project-wide name search could not run at all. The directory listing stays authoritative on its own;
 * this event exists so that outcome is diagnosable rather than silent.
 */
export function logSearchFailed(
    logger: PathBrowserLogger | undefined,
    durationMs: number,
    error: unknown,
): void {
    logger?.write('warn', logEventCatalog.pathBrowser.searchFailed, {
        durationMs,
        fields: { reason: classifySearchFailure(error) },
    });
}

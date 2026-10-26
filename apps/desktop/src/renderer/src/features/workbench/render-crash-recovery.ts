/**
 * Escape hatch for a Session whose content deterministically throws while rendering. The window restores the Server's
 * active Session on every load, so without this a render exception tied to one Session's persisted content brings the
 * crash screen back on each reload with no way to reach another Session. The crash screen records which Session was
 * active; the next load moves the window off that Session through the ordinary `session.select` request before the
 * Workbench mounts it. Nothing on the Server is edited and the Session stays in the sidebar.
 */

/**
 * `sessionStorage` key holding the latest {@link RenderCrashRecord}. Per window and cleared with it, so a crash in one
 * window never moves another window.
 */
const RENDER_CRASH_STORAGE_KEY = 'caxri.render-crash';

/**
 * Two crashes of the same Session closer together than this count as a loop. Longer gaps are treated as unrelated, so
 * an occasional transient crash never moves the user off their Session.
 */
export const RENDER_CRASH_LOOP_WINDOW_MS = 60_000;

interface RenderCrashRecord {
    /**
     * Consecutive crashes of the same Session inside {@link RENDER_CRASH_LOOP_WINDOW_MS}.
     */
    count: number;
    /**
     * Epoch milliseconds of the latest crash.
     */
    at: number;
    /**
     * Active Session when the window crashed, or `undefined` when none was selected.
     */
    sessionId?: string;
    /**
     * Set by the "Reload without this Session" action: skip on the next load without waiting for a second crash.
     */
    skipRequested?: boolean;
}

type CrashStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

function isRecord(value: unknown): value is RenderCrashRecord {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.count === 'number' &&
        typeof record.at === 'number' &&
        (record.sessionId === undefined || typeof record.sessionId === 'string')
    );
}

function readRecord(storage: CrashStorage): RenderCrashRecord | undefined {
    try {
        const raw = storage.getItem(RENDER_CRASH_STORAGE_KEY);
        if (!raw) return undefined;
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Records one render crash. Never throws: the crash screen must stay usable when storage is unavailable.
 */
export function recordRenderCrash(
    storage: CrashStorage,
    crash: { now: number; sessionId?: string; skipRequested?: boolean },
): void {
    const previous = readRecord(storage);
    const isRepeat =
        previous !== undefined &&
        previous.sessionId === crash.sessionId &&
        crash.now - previous.at <= RENDER_CRASH_LOOP_WINDOW_MS;
    const next: RenderCrashRecord = {
        count: isRepeat ? previous.count + 1 : 1,
        at: crash.now,
        ...(crash.sessionId !== undefined && { sessionId: crash.sessionId }),
        ...((crash.skipRequested === true || (isRepeat && previous.skipRequested === true)) && {
            skipRequested: true,
        }),
    };
    try {
        storage.setItem(RENDER_CRASH_STORAGE_KEY, JSON.stringify(next));
    } catch {
        // Recovery is best effort; the plain Reload action still works.
    }
}

/**
 * Returns the Session this load must not restore, if any. The record is cleared once it triggers a skip, so the skip
 * applies once, or once it has expired. A single recent crash stays recorded so that the crash it causes on this load
 * counts as the second one; clearing it here would restart the count on every reload and the loop would never break.
 */
export function takeSessionToSkip(storage: CrashStorage, now: number): string | undefined {
    const record = readRecord(storage);
    if (!record) return undefined;
    const isRecent =
        record.sessionId !== undefined && now - record.at <= RENDER_CRASH_LOOP_WINDOW_MS;
    const skipSessionId =
        isRecent && (record.skipRequested || record.count >= 2) ? record.sessionId : undefined;
    if (skipSessionId !== undefined || !isRecent) {
        try {
            storage.removeItem(RENDER_CRASH_STORAGE_KEY);
        } catch {
            // Ignore: the record expires through the loop window anyway.
        }
    }
    return skipSessionId;
}

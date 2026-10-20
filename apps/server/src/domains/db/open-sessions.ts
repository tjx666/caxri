import type { WindowOpenSessions } from '@caxri/protocol';
import { MAX_OPEN_SESSIONS_PER_WINDOW } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

type OpenSessionsDatabase = Pick<CaxriDatabaseConnection, 'appState'>;

const EMPTY_WINDOW: WindowOpenSessions = { openSessionIds: [], activeSessionId: null };

/**
 * The persisted Open Session working set of one window. Open Sessions never decide whether a Session exists: every
 * writer here receives the IDs that are still valid, and a window nobody has written yet reads as empty.
 */
function readWindowOpenSessions(
    database: OpenSessionsDatabase,
    windowKey: string,
): WindowOpenSessions {
    return database.appState.get('openSessionsByWindow')?.[windowKey] ?? EMPTY_WINDOW;
}

function writeWindow(
    database: OpenSessionsDatabase,
    windowKey: string,
    window: WindowOpenSessions,
): WindowOpenSessions {
    database.appState.set('openSessionsByWindow', {
        ...database.appState.get('openSessionsByWindow'),
        [windowKey]: window,
    });
    return window;
}

/**
 * Makes `sessionId` the window's active Session.
 *
 * - `navigate` (a plain select) activates the entry when it is already open, and otherwise replaces the active entry the
 *   way a browser navigates inside the current tab, so selecting through the sidebar never grows the strip.
 * - `open` (Session creation, moving a Terminal into a new Session) always appends: the new Session is an addition.
 *
 * A full strip drops its oldest non-active entry instead of refusing the Session the user just asked for.
 */
export function activateSessionInWindow(
    database: OpenSessionsDatabase,
    windowKey: string,
    sessionId: string,
    mode: 'navigate' | 'open',
): WindowOpenSessions {
    const { openSessionIds, activeSessionId } = readWindowOpenSessions(database, windowKey);
    if (openSessionIds.includes(sessionId))
        return activeSessionId === sessionId
            ? { openSessionIds, activeSessionId }
            : writeWindow(database, windowKey, { openSessionIds, activeSessionId: sessionId });
    const activeIndex = activeSessionId === null ? -1 : openSessionIds.indexOf(activeSessionId);
    const next =
        mode === 'navigate' && activeIndex !== -1
            ? openSessionIds.with(activeIndex, sessionId)
            : [...openSessionIds, sessionId];
    while (next.length > MAX_OPEN_SESSIONS_PER_WINDOW) {
        const evictable = next.findIndex((id) => id !== sessionId);
        next.splice(evictable, 1);
    }
    return writeWindow(database, windowKey, { openSessionIds: next, activeSessionId: sessionId });
}

/**
 * Stores the strip a window sent, keeping only entries that are still valid and dropping duplicates. The active Session
 * is never part of the request: it stays while it is still listed, and otherwise moves to its neighbor in the previous
 * strip (the next entry, else the one before), else the first remaining entry, so closing the active entry never leaves
 * a dangling pointer.
 */
function replaceWindowOpenSessions(
    database: OpenSessionsDatabase,
    windowKey: string,
    requested: readonly string[],
    validSessionIds: ReadonlySet<string>,
): WindowOpenSessions {
    const previous = readWindowOpenSessions(database, windowKey);
    // eslint-disable-next-line unicorn/prefer-set-methods -- the requested strip order must be preserved
    const openSessionIds = [...new Set(requested)].filter((id) => validSessionIds.has(id));
    let { activeSessionId } = previous;
    if (activeSessionId !== null && !openSessionIds.includes(activeSessionId)) {
        const index = previous.openSessionIds.indexOf(activeSessionId);
        const neighbors = [
            ...previous.openSessionIds.slice(index + 1),
            ...previous.openSessionIds.slice(0, Math.max(index, 0)).toReversed(),
        ];
        activeSessionId = neighbors.find((id) => openSessionIds.includes(id)) ?? null;
    }
    activeSessionId ??= openSessionIds[0] ?? null;
    return writeWindow(database, windowKey, { openSessionIds, activeSessionId });
}

/**
 * Drops every entry of every window that is no longer valid (archived, deleted, or inside a hidden Project) and moves a
 * window whose active Session went away to its neighbor in the strip, else to `fallbackSessionId`, else to none.
 * `fallbackSessionId` is evaluated at most once and only when some window actually needs it.
 *
 * Returns whether any window lost its active Session, which is when the caller also moves the global "last Project"
 * cell the way a single selection used to.
 */
export function reconcileOpenSessions(
    database: OpenSessionsDatabase,
    validSessionIds: ReadonlySet<string>,
    fallbackSessionId: () => string | undefined,
): { activeRemoved: boolean } {
    const windows = database.appState.get('openSessionsByWindow');
    if (!windows) return { activeRemoved: false };
    let isChanged = false;
    let isActiveRemoved = false;
    let fallback: { id: string | undefined } | undefined;
    const next: Record<string, WindowOpenSessions> = {};
    for (const [windowKey, window] of Object.entries(windows)) {
        const kept = window.openSessionIds.filter((id) => validSessionIds.has(id));
        let { activeSessionId } = window;
        if (activeSessionId !== null && !validSessionIds.has(activeSessionId)) {
            isActiveRemoved = true;
            const index = window.openSessionIds.indexOf(activeSessionId);
            const neighbors = [
                ...window.openSessionIds.slice(index + 1),
                ...window.openSessionIds.slice(0, Math.max(index, 0)).toReversed(),
            ];
            activeSessionId = neighbors.find((id) => validSessionIds.has(id)) ?? null;
            if (activeSessionId === null) {
                fallback ??= { id: fallbackSessionId() };
                activeSessionId = fallback.id ?? null;
                if (activeSessionId !== null && !kept.includes(activeSessionId))
                    kept.push(activeSessionId);
            }
        }
        if (
            kept.length !== window.openSessionIds.length ||
            activeSessionId !== window.activeSessionId
        )
            isChanged = true;
        next[windowKey] = { openSessionIds: kept, activeSessionId };
    }
    if (isChanged) database.appState.set('openSessionsByWindow', next);
    return { activeRemoved: isActiveRemoved };
}

/**
 * The window strips as one repository facet: reads, the one atomic write a Renderer edit performs, and the all-windows
 * view that archive, deletion, and hiding reconcile against.
 */
export class WindowOpenSessionsStore {
    constructor(
        private readonly database: CaxriDatabaseConnection,
        private readonly validSessionIds: (
            database: CaxriDatabaseConnection,
        ) => ReadonlySet<string>,
    ) {}

    get(windowKey: string): WindowOpenSessions {
        return readWindowOpenSessions(this.database, windowKey);
    }

    /**
     * Every window's strip keyed by window key, for consumers that act per window (restoring fallback selections).
     */
    all(): Record<string, WindowOpenSessions> {
        return this.database.appState.get('openSessionsByWindow') ?? {};
    }

    set(windowKey: string, requested: readonly string[]): WindowOpenSessions {
        return this.database.transaction(() =>
            replaceWindowOpenSessions(
                this.database,
                windowKey,
                requested,
                this.validSessionIds(this.database),
            ),
        );
    }
}

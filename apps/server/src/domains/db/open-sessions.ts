import type { TearOffWindow, WindowOpenSessions } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

type OpenSessionsDatabase = Pick<CaxriDatabaseConnection, 'appState'>;

const EMPTY_WINDOW: WindowOpenSessions = { openSessionIds: [], activeSessionId: null };

/**
 * The stored shape of a window, copied field by field so the cell never carries anything else.
 */
function stored(window: {
    openSessionIds: string[];
    activeSessionId: string | null;
}): WindowOpenSessions {
    return { openSessionIds: window.openSessionIds, activeSessionId: window.activeSessionId };
}

/**
 * Every window's cell as the Session it shows. A cell written while windows kept a tab strip can still list several
 * Sessions; reading it as just its active one keeps those hidden entries from claiming Sessions for a window that does
 * not show them (see {@link findSessionOwner}), and the next write stores the trimmed shape.
 */
function readWindows(database: OpenSessionsDatabase): Record<string, WindowOpenSessions> {
    const windows = database.appState.get('openSessionsByWindow') ?? {};
    return Object.fromEntries(
        Object.entries(windows).map(([key, { activeSessionId }]) => [
            key,
            {
                openSessionIds: activeSessionId === null ? [] : [activeSessionId],
                activeSessionId,
            },
        ]),
    );
}

/**
 * The primary Workbench window's key. Desktop Main mints every other key (`win-<uuid>`) for a torn-off window.
 */
const PRIMARY_WINDOW_KEY = 'main';

/**
 * Why a tear-off move was refused, carried in `CaxriError.details.reason` so Desktop Main can log a closed reason.
 */
type MoveRefusalReason = 'open_elsewhere' | 'shown_session' | 'target_in_use';

/**
 * Window keys in the order that settles ownership conflicts: the primary window first, then the rest as stored.
 */
function orderedWindowKeys(windows: Record<string, WindowOpenSessions>): string[] {
    const keys = Object.keys(windows);
    return keys.includes(PRIMARY_WINDOW_KEY)
        ? [PRIMARY_WINDOW_KEY, ...keys.filter((key) => key !== PRIMARY_WINDOW_KEY)]
        : keys;
}

/**
 * The window that shows `sessionId`, ignoring `exceptWindowKey`.
 *
 * Ownership invariant: a Session is the Open Session of at most one window, so it is never mounted in two Renderers
 * (two views fighting over one PTY size and one draft). Its writers enforce it: `selectSession` redirects to the owner,
 * and {@link moveSessionToWindow} refuses a Session another window owns.
 */
function findSessionOwner(
    database: OpenSessionsDatabase,
    sessionId: string,
    exceptWindowKey?: string,
): string | undefined {
    const windows = readWindows(database);
    return orderedWindowKeys(windows).find(
        (key) => key !== exceptWindowKey && windows[key].openSessionIds.includes(sessionId),
    );
}

/**
 * The entry that becomes active when `activeSessionId` leaves a strip: its next neighbor, else the one before it.
 */
function neighborOf(
    openSessionIds: readonly string[],
    activeSessionId: string,
    isKept: (id: string) => boolean,
): string | null {
    const index = openSessionIds.indexOf(activeSessionId);
    const neighbors = [
        ...openSessionIds.slice(index + 1),
        ...openSessionIds.slice(0, Math.max(index, 0)).toReversed(),
    ];
    return neighbors.find((id) => id !== activeSessionId && isKept(id)) ?? null;
}

/**
 * The persisted Open Session working set of one window. Open Sessions never decide whether a Session exists: every
 * writer here receives the IDs that are still valid, and a window nobody has written yet reads as empty.
 */
function readWindowOpenSessions(
    database: OpenSessionsDatabase,
    windowKey: string,
): WindowOpenSessions {
    return readWindows(database)[windowKey] ?? EMPTY_WINDOW;
}

function writeWindow(
    database: OpenSessionsDatabase,
    windowKey: string,
    window: WindowOpenSessions,
): WindowOpenSessions {
    database.appState.set('openSessionsByWindow', {
        ...readWindows(database),
        [windowKey]: stored(window),
    });
    return stored(window);
}

/**
 * Makes `sessionId` the Session the window shows. A window holds only the Session it shows: there is no tab strip to
 * keep a second one visible, so navigating replaces the window's Open Sessions instead of growing a hidden working set
 * that would keep claiming Sessions for this window (see {@link findSessionOwner}).
 */
export function activateSessionInWindow(
    database: OpenSessionsDatabase,
    windowKey: string,
    sessionId: string,
): WindowOpenSessions {
    const { openSessionIds, activeSessionId } = readWindowOpenSessions(database, windowKey);
    if (activeSessionId === sessionId && openSessionIds.length === 1)
        return stored({ openSessionIds, activeSessionId });
    return writeWindow(database, windowKey, {
        openSessionIds: [sessionId],
        activeSessionId: sessionId,
    });
}

/**
 * Selects `sessionId` for a window. A Session open in another window is never selected here: the owner activates it
 * instead and its key is returned, leaving the requester's window untouched (see {@link findSessionOwner}). Without a
 * window key (the CLI) there is no per-window effect.
 */
export function selectInWindow(
    database: OpenSessionsDatabase,
    windowKey: string | undefined,
    sessionId: string,
): { ownerWindowKey?: string } {
    if (!windowKey) return {};
    const ownerWindowKey = findSessionOwner(database, sessionId, windowKey);
    activateSessionInWindow(database, ownerWindowKey ?? windowKey, sessionId);
    return ownerWindowKey ? { ownerWindowKey } : {};
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
    const raw = database.appState.get('openSessionsByWindow');
    if (!raw) return { activeRemoved: false };
    const windows = readWindows(database);
    // A cell still in the tab-strip shape (several entries, a Preview field) is rewritten in the trimmed shape.
    let isChanged = Object.values(raw).some(
        (window) =>
            Object.keys(window).length !== 2 ||
            window.openSessionIds.length !== (window.activeSessionId === null ? 0 : 1) ||
            (window.activeSessionId !== null &&
                window.openSessionIds[0] !== window.activeSessionId),
    );
    let isActiveRemoved = false;
    let fallback: { id: string | undefined } | undefined;
    const next: Record<string, WindowOpenSessions> = {};
    // A Session listed by two windows (a hand-edited cell) stays with the first window in ownership order.
    const claimed = new Set<string>();
    for (const windowKey of orderedWindowKeys(windows)) {
        const window = windows[windowKey];
        const kept = [...new Set(window.openSessionIds)].filter(
            (id) => validSessionIds.has(id) && !claimed.has(id),
        );
        let { activeSessionId } = window;
        if (activeSessionId !== null && !kept.includes(activeSessionId)) {
            isActiveRemoved = true;
            /**
             * A fallback must never be a Session another window lists: it would steal that window's entry below.
             */
            const isOwnedByOtherWindow = (id: string): boolean =>
                orderedWindowKeys(windows).some(
                    (key) => key !== windowKey && windows[key].openSessionIds.includes(id),
                );
            const keptSet = new Set(kept);
            activeSessionId = neighborOf(window.openSessionIds, activeSessionId, (id) =>
                keptSet.has(id),
            );
            if (activeSessionId === null) {
                fallback ??= { id: fallbackSessionId() };
                activeSessionId =
                    fallback.id !== undefined && !isOwnedByOtherWindow(fallback.id)
                        ? fallback.id
                        : null;
                if (activeSessionId !== null && !kept.includes(activeSessionId))
                    kept.push(activeSessionId);
            }
        }
        for (const id of kept) claimed.add(id);
        if (
            kept.length !== window.openSessionIds.length ||
            activeSessionId !== window.activeSessionId
        )
            isChanged = true;
        next[windowKey] = stored({ openSessionIds: kept, activeSessionId });
    }
    if (isChanged) database.appState.set('openSessionsByWindow', next);
    return { activeRemoved: isActiveRemoved };
}

/**
 * Opens `sessionId` in a brand-new window `targetKey`, in one `appState` write so a Session is never in zero or two
 * windows. The Session may be any one the source window does not show: "Open in New Window" works from any sidebar row.
 * Refused (with `details.reason`) when it is the Session the source shows (a window never empties itself), when another
 * window already has it open (selecting it brings that window forward instead), or when the target already has one.
 */
function moveSessionToWindow(
    database: OpenSessionsDatabase,
    sourceKey: string,
    targetKey: string,
    sessionId: string,
): { source: WindowOpenSessions; target: WindowOpenSessions } {
    if (targetKey === PRIMARY_WINDOW_KEY || targetKey === sourceKey)
        throw new CaxriError('VALIDATION', 'A Session can only move to a new window');
    const source = readWindowOpenSessions(database, sourceKey);
    const refuse = (reason: MoveRefusalReason, message: string): never => {
        throw new CaxriError('CONFLICT', message, { reason });
    };
    if (source.activeSessionId === sessionId)
        refuse('shown_session', 'A window keeps the Session it shows');
    if (findSessionOwner(database, sessionId, sourceKey) !== undefined)
        refuse('open_elsewhere', 'The Session is open in another window');
    if (readWindowOpenSessions(database, targetKey).openSessionIds.length > 0)
        refuse('target_in_use', 'The target window already has Open Sessions');
    const nextSource = stored({
        openSessionIds: source.openSessionIds.filter((id) => id !== sessionId),
        activeSessionId: source.activeSessionId,
    });
    const target = { openSessionIds: [sessionId], activeSessionId: sessionId };
    database.appState.set('openSessionsByWindow', {
        ...readWindows(database),
        [sourceKey]: nextSource,
        [targetKey]: target,
    });
    return { source: nextSource, target };
}

/**
 * Every window's Open Sessions as one repository facet: reads, the atomic move into a new window, and the all-windows
 * view that archive, deletion, and hiding reconcile against.
 */
export class WindowOpenSessionsStore {
    constructor(private readonly database: CaxriDatabaseConnection) {}

    get(windowKey: string): WindowOpenSessions {
        return readWindowOpenSessions(this.database, windowKey);
    }

    /**
     * Every Session open in a window other than `windowKey`, for the sidebar's "open in another window" marker.
     */
    ownedElsewhere(windowKey: string): string[] {
        const windows = this.all();
        return orderedWindowKeys(windows)
            .filter((key) => key !== windowKey)
            .flatMap((key) => windows[key].openSessionIds);
    }

    /**
     * Every window's strip keyed by window key, for consumers that act per window (restoring fallback selections).
     */
    all(): Record<string, WindowOpenSessions> {
        return readWindows(this.database);
    }

    /**
     * The window that lists `sessionId` among its Open Sessions, other than `exceptWindowKey`.
     */
    owner(sessionId: string, exceptWindowKey?: string): string | undefined {
        return findSessionOwner(this.database, sessionId, exceptWindowKey);
    }

    moveToWindow(
        sourceKey: string,
        targetKey: string,
        sessionId: string,
    ): { source: WindowOpenSessions; target: WindowOpenSessions } {
        return this.database.transaction(() =>
            moveSessionToWindow(this.database, sourceKey, targetKey, sessionId),
        );
    }

    /**
     * Forgets a torn-off window's strip. The primary window's record is never released.
     */
    release(windowKey: string): void {
        if (windowKey === PRIMARY_WINDOW_KEY) return;
        this.database.transaction(() => {
            const { [windowKey]: released, ...rest } = this.all();
            if (released as WindowOpenSessions | undefined)
                this.database.appState.set('openSessionsByWindow', rest);
        });
    }

    /**
     * Every non-primary window that still has Open Sessions, for Main to reopen after a restart.
     */
    listTearOffs(): TearOffWindow[] {
        return Object.entries(this.all())
            .filter(
                ([key, window]) => key !== PRIMARY_WINDOW_KEY && window.openSessionIds.length > 0,
            )
            .map(([windowKey, window]) => ({ windowKey, ...window }));
    }
}

import type { TearOffWindow, WindowOpenSessions } from '@caxri/protocol';
import { CaxriError, MAX_OPEN_SESSIONS_PER_WINDOW } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

type OpenSessionsDatabase = Pick<CaxriDatabaseConnection, 'appState'>;

const EMPTY_WINDOW: WindowOpenSessions = { openSessionIds: [], activeSessionId: null };

/**
 * The stored shape of a window: `previewSessionId` is written only while a Preview entry exists, so a window with none
 * (every entry kept) is byte-identical to a record written before Preview entries existed.
 */
function stored(window: {
    openSessionIds: string[];
    activeSessionId: string | null;
    previewSessionId?: string | null;
}): WindowOpenSessions {
    const { previewSessionId, ...rest } = window;
    return previewSessionId ? { ...rest, previewSessionId } : rest;
}

/**
 * The primary Workbench window's key. Desktop Main mints every other key (`win-<uuid>`) for a torn-off window.
 */
const PRIMARY_WINDOW_KEY = 'main';

/**
 * Why a tear-off move was refused, carried in `CaxriError.details.reason` so Desktop Main can log a closed reason.
 */
type MoveRefusalReason = 'last_tab' | 'not_open' | 'target_in_use';

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
 * The window whose strip lists `sessionId`, ignoring `exceptWindowKey`.
 *
 * Ownership invariant: a Session is an Open Session of at most one window. It is entry-level (membership in
 * `openSessionIds`), not just the active Session, because an active-only rule would let the owner switch tabs onto a
 * Session another window shows and mount it in two Renderers (two views fighting over one PTY size and one draft). Two
 * writers enforce it: `selectSession` redirects to the owner, and {@link replaceWindowOpenSessions} drops entries
 * another window owns.
 */
function findSessionOwner(
    database: OpenSessionsDatabase,
    sessionId: string,
    exceptWindowKey?: string,
): string | undefined {
    const windows = database.appState.get('openSessionsByWindow') ?? {};
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
    return database.appState.get('openSessionsByWindow')?.[windowKey] ?? EMPTY_WINDOW;
}

function writeWindow(
    database: OpenSessionsDatabase,
    windowKey: string,
    window: WindowOpenSessions,
): WindowOpenSessions {
    database.appState.set('openSessionsByWindow', {
        ...database.appState.get('openSessionsByWindow'),
        [windowKey]: stored(window),
    });
    return stored(window);
}

/**
 * Makes `sessionId` the window's active Session.
 *
 * An entry that is already open is only activated (a Preview entry stays a Preview entry). Otherwise:
 *
 * - `navigate` (a plain select: a sidebar click, Cmd+N, session creation) is the VS Code "preview" rule. It replaces the
 *   window's Preview entry in place, or, when there is none, adds the Session right of the active entry as the new
 *   Preview entry. A kept entry is never replaced, so navigation can never make a tab the user chose vanish.
 * - `newTab` (an explicit open: the strip's `+`, moving a Terminal into a new Session) inserts a kept entry right of the
 *   active one, the way a browser opens a link in a new tab. With no active entry it appends. The Preview entry is left
 *   alone.
 *
 * A full strip drops its oldest non-active entry instead of refusing the Session the user just asked for.
 */
export function activateSessionInWindow(
    database: OpenSessionsDatabase,
    windowKey: string,
    sessionId: string,
    placement: 'navigate' | 'newTab',
): WindowOpenSessions {
    const {
        openSessionIds,
        activeSessionId,
        previewSessionId = null,
    } = readWindowOpenSessions(database, windowKey);
    if (openSessionIds.includes(sessionId))
        return activeSessionId === sessionId
            ? stored({ openSessionIds, activeSessionId, previewSessionId })
            : writeWindow(database, windowKey, {
                  openSessionIds,
                  activeSessionId: sessionId,
                  previewSessionId,
              });
    const previewIndex = previewSessionId === null ? -1 : openSessionIds.indexOf(previewSessionId);
    let next: string[];
    let nextPreview = previewIndex === -1 ? null : previewSessionId;
    if (placement === 'navigate' && previewIndex !== -1) {
        next = openSessionIds.with(previewIndex, sessionId);
        nextPreview = sessionId;
    } else {
        const activeIndex = activeSessionId === null ? -1 : openSessionIds.indexOf(activeSessionId);
        next = openSessionIds.toSpliced(
            activeIndex === -1 ? openSessionIds.length : activeIndex + 1,
            0,
            sessionId,
        );
        if (placement === 'navigate') nextPreview = sessionId;
    }
    while (next.length > MAX_OPEN_SESSIONS_PER_WINDOW) {
        const evictable = next.findIndex((id) => id !== sessionId);
        if (next[evictable] === nextPreview) nextPreview = null;
        next.splice(evictable, 1);
    }
    return writeWindow(database, windowKey, {
        openSessionIds: next,
        activeSessionId: sessionId,
        previewSessionId: nextPreview,
    });
}

/**
 * Promotes the window's Preview entry to a kept entry when it is `sessionId`; any other Session leaves the window
 * untouched. Promotion is the only way an entry stops being a Preview entry besides leaving the strip.
 */
function keepOpenSession(
    database: OpenSessionsDatabase,
    windowKey: string,
    sessionId: string,
): WindowOpenSessions {
    const window = readWindowOpenSessions(database, windowKey);
    return window.previewSessionId === sessionId
        ? writeWindow(database, windowKey, { ...window, previewSessionId: null })
        : window;
}

/**
 * Selects `sessionId` for a window. A Session open in another window is never selected here: the owner activates it
 * instead and its key is returned, leaving the requester's strip untouched (see {@link findSessionOwner}). Without a
 * window key (the CLI) there is no per-window effect.
 */
export function selectInWindow(
    database: OpenSessionsDatabase,
    windowKey: string | undefined,
    sessionId: string,
): { ownerWindowKey?: string } {
    if (!windowKey) return {};
    const ownerWindowKey = findSessionOwner(database, sessionId, windowKey);
    activateSessionInWindow(database, ownerWindowKey ?? windowKey, sessionId, 'navigate');
    return ownerWindowKey ? { ownerWindowKey } : {};
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
    const windows = database.appState.get('openSessionsByWindow') ?? {};
    const ownedElsewhere = new Set(
        Object.entries(windows).flatMap(([key, window]) =>
            key === windowKey ? [] : window.openSessionIds,
        ),
    );

    const openSessionIds = [...new Set(requested)].filter(
        (id) => validSessionIds.has(id) && !ownedElsewhere.has(id),
    );
    let { activeSessionId } = previous;
    if (activeSessionId !== null && !openSessionIds.includes(activeSessionId)) {
        const openSet = new Set(openSessionIds);
        activeSessionId = neighborOf(previous.openSessionIds, activeSessionId, (id) =>
            openSet.has(id),
        );
    }
    activeSessionId ??= openSessionIds[0] ?? null;
    // Every entry this edit adds is kept; the Preview entry survives only while it is still listed.
    const previewSessionId =
        previous.previewSessionId && openSessionIds.includes(previous.previewSessionId)
            ? previous.previewSessionId
            : null;
    return writeWindow(database, windowKey, { openSessionIds, activeSessionId, previewSessionId });
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
        // A fallback appended above is a kept entry: it is the user's only way to keep working in this window.
        const previewSessionId =
            window.previewSessionId && kept.includes(window.previewSessionId)
                ? window.previewSessionId
                : null;
        if (
            kept.length !== window.openSessionIds.length ||
            activeSessionId !== window.activeSessionId ||
            previewSessionId !== (window.previewSessionId ?? null)
        )
            isChanged = true;
        next[windowKey] = stored({ openSessionIds: kept, activeSessionId, previewSessionId });
    }
    if (isChanged) database.appState.set('openSessionsByWindow', next);
    return { activeRemoved: isActiveRemoved };
}

/**
 * Moves `sessionId` out of `sourceKey`'s strip into a brand-new strip for `targetKey`, in one `appState` write so a
 * Session is never in zero or two windows. Refused (with `details.reason`) when the Session is not open in the source,
 * is the source's last tab (a window never empties by tearing off), or the target already has a strip.
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
    if (!source.openSessionIds.includes(sessionId))
        refuse('not_open', 'The Session is not open in the source window');
    if (source.openSessionIds.length < 2)
        refuse('last_tab', 'A window keeps at least one Open Session');
    if (readWindowOpenSessions(database, targetKey).openSessionIds.length > 0)
        refuse('target_in_use', 'The target window already has Open Sessions');
    const openSessionIds = source.openSessionIds.filter((id) => id !== sessionId);
    const activeSessionId =
        source.activeSessionId === sessionId
            ? neighborOf(source.openSessionIds, sessionId, () => true)
            : source.activeSessionId;
    // Tearing a tab off is a deliberate act, so the moved Session is kept in its new window; the source keeps its Preview
    // entry unless that is the one that left.
    const nextSource = stored({
        openSessionIds,
        activeSessionId,
        previewSessionId: source.previewSessionId === sessionId ? null : source.previewSessionId,
    });
    const target = { openSessionIds: [sessionId], activeSessionId: sessionId };
    database.appState.set('openSessionsByWindow', {
        ...database.appState.get('openSessionsByWindow'),
        [sourceKey]: nextSource,
        [targetKey]: target,
    });
    return { source: nextSource, target };
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
        return this.database.appState.get('openSessionsByWindow') ?? {};
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

    /**
     * Promotes the Preview entry to a kept entry, see {@link keepOpenSession}.
     */
    keep(windowKey: string, sessionId: string): WindowOpenSessions {
        return this.database.transaction(() =>
            keepOpenSession(this.database, windowKey, sessionId),
        );
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

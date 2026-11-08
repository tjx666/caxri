import { environmentOfSession } from '../../../lib/environment-routing';
import { createStore } from '../../../lib/store';
import { storageScopeOf } from '../../../stores/environment';
import type { PortalItems } from './portal-items';
import {
    closePortalItem,
    EMPTY_PORTAL_ITEMS,
    openPortalItem,
    retainPortalItems,
    selectPortalItem,
} from './portal-items';
import type { PortalEntry } from './portal-persistence';
import {
    persistPortalEntries,
    readPortalEntries,
    subscribePortalEntries,
} from './portal-persistence';

/**
 * The Portal's items per Session: the flyout that shows a Chat's subagent and background shell tasks, turn reviews,
 * side chat, and Context breakdown over the right edge of the window instead of splitting the Workbench (issue #2370).
 *
 * Keyed by Session so switching away and back finds the same items open. The items, their order, and the active one
 * survive a restart in this device's `localStorage` (`portal-persistence.ts`), shared by every window of the profile: a
 * write patches only the Sessions it changed, and another window's change arrives through the `storage` event. Each
 * item path names its owning Chat, and `useRetainLivePortalItems` drops items whose Chat is gone once the workbench
 * snapshot has loaded. Maximized is transient and per window: a restart or closing the Portal shows the Chat again.
 * "Open in Split" turns an item into an ordinary pane tab, which the layout persists like any other.
 */
interface PortalState {
    bySession: Readonly<Record<string, PortalItems>>;
    /**
     * The machine that owns each Session in `bySession` (`storageScopeOf`), recorded when its items are first written.
     */
    scopeBySession: Readonly<Record<string, string>>;
    /**
     * The Session whose Portal currently covers the whole Workbench area and hides its Chat; at most one, never
     * persisted.
     */
    maximizedSessionId?: string;
    toggleMaximized(sessionId: string): void;
    restore(sessionId: string): void;
    /**
     * Forgets the Portal items of Sessions `isDeleted` confirms gone. It is asked with each Session's owning machine,
     * so a window can answer only for machines whose Sessions it actually lists and leave the rest alone.
     */
    pruneSessions(isDeleted: (sessionId: string, scope: string) => boolean): void;
    open(sessionId: string, path: string): void;
    select(sessionId: string, path: string): void;
    close(sessionId: string, path: string): void;
    closeAll(sessionId: string): void;
    retain(sessionId: string, isLive: (path: string) => boolean): void;
}

function splitEntries(entries: Readonly<Record<string, PortalEntry>>): {
    bySession: Record<string, PortalItems>;
    scopeBySession: Record<string, string>;
} {
    return {
        bySession: Object.fromEntries(
            Object.entries(entries).map(([sessionId, { items }]) => [sessionId, items]),
        ),
        scopeBySession: Object.fromEntries(
            Object.entries(entries).map(([sessionId, { scope }]) => [sessionId, scope]),
        ),
    };
}

/**
 * The state a merged record stands for. A maximized Portal whose Session left the record (closed here or by another
 * window) is restored.
 */
function stateFromEntries(
    entries: Readonly<Record<string, PortalEntry>>,
    maximizedSessionId: string | undefined,
): Pick<PortalState, 'bySession' | 'maximizedSessionId' | 'scopeBySession'> {
    return {
        ...splitEntries(entries),
        maximizedSessionId:
            maximizedSessionId !== undefined && !(maximizedSessionId in entries)
                ? undefined
                : maximizedSessionId,
    };
}

export const usePortalStore = createStore<PortalState>('agent-chat-portal', (set, get) => {
    /**
     * Applies this window's change to memory and writes just those Sessions into the shared record. Memory is changed
     * directly rather than replaced by the merged record the write returns: Sessions other windows saved arrive through
     * the `storage` event, and a window whose storage is unavailable still works for its own Sessions.
     */
    const commit = (changes: Readonly<Record<string, PortalEntry | undefined>>): void => {
        const { bySession, maximizedSessionId, scopeBySession } = get();
        const nextItems = { ...bySession };
        const nextScopes = { ...scopeBySession };
        for (const [sessionId, entry] of Object.entries(changes)) {
            if (entry) {
                nextItems[sessionId] = entry.items;
                nextScopes[sessionId] = entry.scope;
            } else {
                delete nextItems[sessionId];
                delete nextScopes[sessionId];
            }
        }
        set({
            bySession: nextItems,
            scopeBySession: nextScopes,
            maximizedSessionId:
                maximizedSessionId !== undefined && !(maximizedSessionId in nextItems)
                    ? undefined
                    : maximizedSessionId,
        });
        persistPortalEntries(changes);
    };
    const update = (sessionId: string, next: (items: PortalItems) => PortalItems): void => {
        const current = get().bySession[sessionId] ?? EMPTY_PORTAL_ITEMS;
        const items = next(current);
        if (items === current) return;
        const scope =
            get().scopeBySession[sessionId] ?? storageScopeOf(environmentOfSession(sessionId));
        commit({ [sessionId]: items.paths.length === 0 ? undefined : { items, scope } });
    };
    // Lives as long as the store. It adopts another window's record into memory only; nothing here writes, so a change
    // never echoes back.
    subscribePortalEntries((entries) => set(stateFromEntries(entries, get().maximizedSessionId)));
    return {
        ...stateFromEntries(readPortalEntries(), undefined),
        toggleMaximized: (sessionId) =>
            set({
                maximizedSessionId: get().maximizedSessionId === sessionId ? undefined : sessionId,
            }),
        restore: (sessionId) => {
            if (get().maximizedSessionId === sessionId) set({ maximizedSessionId: undefined });
        },
        pruneSessions: (isDeleted) => {
            const { bySession, scopeBySession } = get();
            const changes = Object.fromEntries(
                Object.keys(bySession)
                    .filter((sessionId) =>
                        isDeleted(sessionId, scopeBySession[sessionId] ?? 'local'),
                    )
                    .map((sessionId) => [sessionId, undefined]),
            );
            if (Object.keys(changes).length === 0) return;
            commit(changes);
        },
        open: (sessionId, path) => update(sessionId, (items) => openPortalItem(items, path)),
        select: (sessionId, path) => update(sessionId, (items) => selectPortalItem(items, path)),
        close: (sessionId, path) => update(sessionId, (items) => closePortalItem(items, path)),
        closeAll: (sessionId) => update(sessionId, () => EMPTY_PORTAL_ITEMS),
        retain: (sessionId, isLive) =>
            update(sessionId, (items) => retainPortalItems(items, isLive)),
    };
});

export function usePortalItems(sessionId: string | undefined): PortalItems {
    return usePortalStore((state) =>
        sessionId ? (state.bySession[sessionId] ?? EMPTY_PORTAL_ITEMS) : EMPTY_PORTAL_ITEMS,
    );
}

export function useIsPortalMaximized(sessionId: string | undefined): boolean {
    return usePortalStore(
        (state) => sessionId !== undefined && state.maximizedSessionId === sessionId,
    );
}

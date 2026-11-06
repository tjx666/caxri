import { readLocalStorageJson, writeLocalStorageJson } from '../../../lib/local-storage';
import { createStore } from '../../../lib/store';
import type { PortalItems } from './portal-items';
import {
    closePortalItem,
    EMPTY_PORTAL_ITEMS,
    openPortalItem,
    retainPortalItems,
    selectPortalItem,
} from './portal-items';
import { parsePortalItems, PORTAL_STORAGE_KEY, serializePortalItems } from './portal-persistence';

/**
 * The Portal's items per Session: the flyout that shows a Chat's subagent and background shell tasks, turn reviews,
 * side chat, and Context breakdown over the right edge of the window instead of splitting the Workbench (issue #2370).
 *
 * Keyed by Session so switching away and back finds the same items open. The items, their order, and the active one
 * survive a restart in this device's `localStorage` (`portal-persistence.ts`); each item path names its owning Chat,
 * and `useRetainLivePortalItems` drops items whose Chat is gone once the workbench snapshot has loaded. Maximized is
 * transient: a restart or closing the Portal shows the Chat again. "Open in Split" turns an item into an ordinary pane
 * tab, which the layout persists like any other.
 */
interface PortalState {
    bySession: Readonly<Record<string, PortalItems>>;
    /**
     * The Session whose Portal currently covers the whole Workbench area and hides its Chat; at most one, never
     * persisted.
     */
    maximizedSessionId?: string;
    toggleMaximized(sessionId: string): void;
    restore(sessionId: string): void;
    /**
     * Forgets Portal items of Sessions that no longer exist.
     */
    pruneSessions(isLive: (sessionId: string) => boolean): void;
    open(sessionId: string, path: string): void;
    select(sessionId: string, path: string): void;
    close(sessionId: string, path: string): void;
    closeAll(sessionId: string): void;
    retain(sessionId: string, isLive: (path: string) => boolean): void;
}

export const usePortalStore = createStore<PortalState>('agent-chat-portal', (set, get) => {
    const update = (sessionId: string, next: (items: PortalItems) => PortalItems): void => {
        const current = get().bySession[sessionId] ?? EMPTY_PORTAL_ITEMS;
        const items = next(current);
        if (items === current) return;
        const bySession = { ...get().bySession };
        if (items.paths.length === 0) delete bySession[sessionId];
        else bySession[sessionId] = items;
        const maximizedSessionId =
            items.paths.length === 0 && get().maximizedSessionId === sessionId
                ? undefined
                : get().maximizedSessionId;
        set({ bySession, maximizedSessionId });
        writeLocalStorageJson(PORTAL_STORAGE_KEY, serializePortalItems(bySession));
    };
    return {
        bySession: parsePortalItems(readLocalStorageJson(PORTAL_STORAGE_KEY)),
        maximizedSessionId: undefined,
        toggleMaximized: (sessionId) =>
            set({
                maximizedSessionId: get().maximizedSessionId === sessionId ? undefined : sessionId,
            }),
        restore: (sessionId) => {
            if (get().maximizedSessionId === sessionId) set({ maximizedSessionId: undefined });
        },
        pruneSessions: (isLive) => {
            const bySession = Object.fromEntries(
                Object.entries(get().bySession).filter(([sessionId]) => isLive(sessionId)),
            );
            if (Object.keys(bySession).length === Object.keys(get().bySession).length) return;
            set({ bySession });
            writeLocalStorageJson(PORTAL_STORAGE_KEY, serializePortalItems(bySession));
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

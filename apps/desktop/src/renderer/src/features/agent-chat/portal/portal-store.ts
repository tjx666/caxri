import { createStore } from '../../../lib/store';
import type { PortalItems } from './portal-items';
import {
    closePortalItem,
    EMPTY_PORTAL_ITEMS,
    openPortalItem,
    retainPortalItems,
    selectPortalItem,
} from './portal-items';

/**
 * The Portal's items per Session: the flyout that shows a Chat's subagent and background shell tasks, turn reviews,
 * side chat, and Context breakdown over the right edge of the window instead of splitting the Workbench (issue #2370).
 *
 * Window-local and never persisted: a Portal is a glance at work beside a Chat, so a restart starts with it closed.
 * Keyed by Session so switching away and back finds the same items open. "Open in Split" turns an item into an ordinary
 * pane tab, which the layout persists like any other.
 */
interface PortalState {
    bySession: Readonly<Record<string, PortalItems>>;
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
        set({ bySession });
    };
    return {
        bySession: {},
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

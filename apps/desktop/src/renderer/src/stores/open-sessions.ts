import type { WindowOpenSessions } from '@caxri/protocol';

import { mergeStructurally } from './structural-sharing';
import { useWorkbenchStore } from './workbench';

/**
 * The strip appears from this many Open Sessions on. One Open Session is just "the Session you are in", and a lone tab
 * would only spend 36px of title bar on a choice that does not exist.
 */
export const SESSION_TAB_STRIP_MIN_SESSIONS = 2;

const NO_OPEN_SESSIONS: readonly string[] = [];

/**
 * This window's Open Sessions live in the Server snapshot (`bootstrap.openSessionIds`), not in a second Renderer store,
 * so there is no copy to drift from the Server's pruning of archived and deleted Sessions. These readers are the only
 * way the strip and the Workbench look at them, and every one selects a stable slice: `mergeStructurally` keeps the
 * array's identity until its contents change, so a Session switch or a Terminal title change re-renders none of these
 * consumers, and a reorder re-renders only the strip.
 */
export function useOpenSessionIds(): readonly string[] {
    return useWorkbenchStore((state) => state.bootstrap?.openSessionIds ?? NO_OPEN_SESSIONS);
}

/**
 * A boolean, so the many `PaneView`s of a keep-alive Workbench re-render only when the strip appears or disappears, not
 * on every edit to it.
 */
export function useIsSessionTabStripVisible(): boolean {
    return useWorkbenchStore(
        (state) => (state.bootstrap?.openSessionIds?.length ?? 0) >= SESSION_TAB_STRIP_MIN_SESSIONS,
    );
}

export function getOpenSessionIds(): readonly string[] {
    return useWorkbenchStore.getState().bootstrap?.openSessionIds ?? NO_OPEN_SESSIONS;
}

/**
 * Writes a strip edit into the snapshot, both for the optimistic update before the Server answers and for the Server's
 * own answer. A `null` active Session leaves the current selection alone: the Server only reports `null` for an empty
 * strip, which a window that still shows a Session never has.
 */
export function applyWindowOpenSessions(window: WindowOpenSessions): void {
    useWorkbenchStore.setState((current) => {
        if (!current.bootstrap) return current;
        const next = {
            ...current.bootstrap,
            openSessionIds: window.openSessionIds,
            selectedSessionId: window.activeSessionId ?? current.bootstrap.selectedSessionId,
        };
        return { bootstrap: mergeStructurally(current.bootstrap, next) };
    });
}

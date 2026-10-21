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

/**
 * Where a Session is open, for the sidebar's marker: `here` in this window's strip, `elsewhere` in another window's,
 * and `undefined` when it is in no strip. `here` is withheld while the strip is hidden (fewer than
 * {@link SESSION_TAB_STRIP_MIN_SESSIONS} entries), because a marker for "the Session you are in" with no strip to point
 * at would only be noise. The Server keeps the two sets disjoint (a Session is open in at most one window).
 */
export type SessionOpenPlace = 'here' | 'elsewhere';

export function sessionOpenPlace(
    openSessionIds: readonly string[] | undefined,
    otherWindowOpenSessionIds: readonly string[] | undefined,
    sessionId: string,
): SessionOpenPlace | undefined {
    if (
        openSessionIds &&
        openSessionIds.length >= SESSION_TAB_STRIP_MIN_SESSIONS &&
        openSessionIds.includes(sessionId)
    )
        return 'here';
    return otherWindowOpenSessionIds?.includes(sessionId) ? 'elsewhere' : undefined;
}

/**
 * One Session's {@link SessionOpenPlace}, selected as a primitive so a row re-renders only when its own marker flips,
 * not on every strip edit or Session switch.
 */
export function useSessionOpenPlace(sessionId: string): SessionOpenPlace | undefined {
    return useWorkbenchStore((state) =>
        sessionOpenPlace(
            state.bootstrap?.openSessionIds,
            state.bootstrap?.otherWindowOpenSessionIds,
            sessionId,
        ),
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

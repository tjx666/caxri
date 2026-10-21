import { useWorkbenchStore } from './workbench';

/**
 * Whether `sessionId` is open in another window, for the sidebar's marker. A window holds only the Session it shows,
 * and the Server keeps windows disjoint, so this is exactly "another window shows it": selecting the row brings that
 * window forward instead of opening the Session here.
 */
export function isSessionOpenElsewhere(
    otherWindowOpenSessionIds: readonly string[] | undefined,
    sessionId: string,
): boolean {
    return otherWindowOpenSessionIds?.includes(sessionId) ?? false;
}

/**
 * {@link isSessionOpenElsewhere} for one row, selected as a primitive so a row re-renders only when its own marker
 * flips, not on every Session switch.
 */
export function useIsSessionOpenElsewhere(sessionId: string): boolean {
    return useWorkbenchStore((state) =>
        isSessionOpenElsewhere(state.bootstrap?.otherWindowOpenSessionIds, sessionId),
    );
}

import { useCallback } from 'react';

import { createSharedLocalState } from '../../../lib/local-storage';
import { createStore } from '../../../lib/store';

/**
 * Separate from the Project collapse record on purpose. That one is reconciled against the live Project catalog and
 * drops any key it cannot match to a Project, so the Pinned group (which no Project owns) would have its state
 * discarded on every pass.
 */
const STORAGE_KEY = 'caxri.primary-sidebar-pinned-collapsed';

/**
 * Shared by every window of the profile (docs/client-local-data.md): collapsing the Pinned group in one window
 * collapses it in the others and after a restart.
 */
const sharedCollapsed = createSharedLocalState(
    STORAGE_KEY,
    (raw) => raw === true || raw === 'true',
);

interface PinnedCollapseState {
    isCollapsed: boolean;
}

const usePinnedCollapseStore = createStore<PinnedCollapseState>('pinned-collapse', (set) => {
    // Lives as long as the store. It updates memory only, so another window's change never writes back.
    sharedCollapsed.subscribe((isCollapsed) => set({ isCollapsed }));
    return { isCollapsed: sharedCollapsed.read() };
});

function setCollapsed(isCollapsed: boolean): void {
    if (usePinnedCollapseStore.getState().isCollapsed === isCollapsed) return;
    usePinnedCollapseStore.setState({ isCollapsed });
    sharedCollapsed.write(isCollapsed);
}

/**
 * Whether the Pinned group is open, remembered across launches. Defaults to open: a user who has pinned something has
 * said it is what they want to see first, so a first launch that hid it behind a chevron would bury the feature.
 */
export function usePinnedCollapse(): {
    expand: () => void;
    expanded: boolean;
    toggle: () => void;
} {
    const isCollapsed = usePinnedCollapseStore((state) => state.isCollapsed);
    const toggle = useCallback(
        () => setCollapsed(!usePinnedCollapseStore.getState().isCollapsed),
        [],
    );
    // For commands that must put a pinned Session's row on screen before acting on it, such as `session.rename`.
    const expand = useCallback(() => setCollapsed(false), []);
    return { expand, expanded: !isCollapsed, toggle };
}

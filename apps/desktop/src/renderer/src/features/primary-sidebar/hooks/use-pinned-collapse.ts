import { useCallback, useEffect, useState } from 'react';

/**
 * Separate from the Project collapse record on purpose. That one is reconciled against the live Project catalog and
 * drops any key it cannot match to a Project, so the Pinned group (which no Project owns) would have its state
 * discarded on every pass.
 */
const STORAGE_KEY = 'caxri.primary-sidebar-pinned-collapsed';

function isBrowser(): boolean {
    // DOM types declare these globals as always present, but this module also loads in Vitest's Node environment.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    return typeof window !== 'undefined' && globalThis.localStorage !== undefined;
}

function wasCollapsed(): boolean {
    if (!isBrowser()) return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
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
    const [collapsed, setCollapsed] = useState(wasCollapsed);
    useEffect(() => {
        if (!isBrowser()) return;
        try {
            localStorage.setItem(STORAGE_KEY, String(collapsed));
        } catch {
            // Storage-disabled windows keep the disclosure state for this Renderer lifetime.
        }
    }, [collapsed]);
    const toggle = useCallback(() => setCollapsed((current) => !current), []);
    // For commands that must put a pinned Session's row on screen before acting on it, such as `session.rename`.
    const expand = useCallback(() => setCollapsed(false), []);
    return { expand, expanded: !collapsed, toggle };
}

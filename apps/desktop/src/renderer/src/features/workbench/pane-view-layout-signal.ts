import { createContext, use } from 'react';

/**
 * An opaque token, `PaneView`'s current `PaneLayout` reference, that changes whenever the split tree may have moved a
 * pane's `data-pane-slot` marker to a new DOM node. A split or merge recreates that marker under a new parent even when
 * the pane id it carries does not change, and a plain layout reference change is a safe superset of every case that can
 * do it: `PaneMountPortal` depends on this signal instead of its own paneId alone (issue #815).
 *
 * Provided during `PaneView`'s render, not populated by one of its own effects: React runs a child's layout effects
 * before its parent's, so an effect-populated signal would not reach `PaneMountPortal`'s layout effect in time on first
 * mount. A context value read during render sidesteps that ordering: it is already resolved by the time any
 * descendant's render, and therefore any descendant's effects, run.
 */
const PaneViewLayoutSignalContext = createContext<unknown>(undefined);

export const PaneViewLayoutSignalProvider = PaneViewLayoutSignalContext.Provider;

export function usePaneViewLayoutSignal(): unknown {
    return use(PaneViewLayoutSignalContext);
}

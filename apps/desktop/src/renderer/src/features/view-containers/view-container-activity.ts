import type { ReactNode } from 'react';
import { createContext, createElement, useContext } from 'react';

/**
 * Whether the keep-alive view container currently owns the visible tab. Hidden panels stay mounted so scroll, focus,
 * and expansion survive a switch, but they must not keep talking to Server Core or the Extension Host.
 *
 * Defaults to `true` so a view rendered outside `ViewContainerSurface` (tests, isolated providers) still loads.
 */
const ViewContainerActivityContext = createContext(true);

export function ViewContainerActivityProvider({
    children,
    isActive,
}: {
    children: ReactNode;
    isActive: boolean;
}) {
    return createElement(ViewContainerActivityContext, { value: isActive }, children);
}

export function useIsViewContainerActive(): boolean {
    return useContext(ViewContainerActivityContext);
}

/**
 * Keep-alive views pause their Server reads while another container is selected. Extra gates (no Session, empty search)
 * still apply; a hidden panel never fetches just because those other gates passed.
 */
export function isViewContainerQueryEnabled(isActive: boolean, isExtraEnabled = true): boolean {
    return isActive && isExtraEnabled;
}

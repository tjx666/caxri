import type { ReactNode } from 'react';
import { createContext, createElement, useContext, useEffect, useState } from 'react';

import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';

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
 * Which input a keep-alive view renders from: the live value while its container is visible, otherwise the value it
 * last showed. A hidden view that followed every Session or work-tab switch re-keyed its queries for nothing on screen,
 * and a disabled query under a fresh key drops to `loading`, which remounted the whole hidden tree.
 */
export function resolveHeldWhileHidden<T>(
    isActive: boolean,
    held: T,
    live: T,
    isSame: (left: T, right: T) => boolean = Object.is,
): T {
    return isActive && !isSame(held, live) ? live : held;
}

/**
 * Holds `live` frozen while the surrounding view container is hidden and adopts it during render on reveal, so the
 * stale value never paints. See {@link resolveHeldWhileHidden}.
 */
export function useHeldWhileHidden<T>(
    live: T,
    isSame: (left: T, right: T) => boolean = Object.is,
): T {
    const isActive = useIsViewContainerActive();
    const [held, setHeld] = useState(() => live);
    const shown = resolveHeldWhileHidden(isActive, held, live, isSame);
    if (shown !== held) setHeld(() => shown);
    return shown;
}

/**
 * Keep-alive views pause their Server reads while another container is selected. Extra gates (no Session, empty search)
 * still apply; a hidden panel never fetches just because those other gates passed.
 */
export function isViewContainerQueryEnabled(isActive: boolean, isExtraEnabled = true): boolean {
    return isActive && isExtraEnabled;
}

/**
 * `enabled: false` only blocks new fetches. A keep-alive panel that hides mid-request would otherwise keep talking to
 * Server Core until that promise settled.
 */
export function cancelViewContainerQuery(
    queryClient: QueryClient,
    queryKey: readonly unknown[],
): Promise<void> {
    return queryClient.cancelQueries({ queryKey, exact: true });
}

export function useCancelViewContainerQueryWhenHidden(
    queryKey: readonly unknown[],
    isActive: boolean,
): void {
    const queryClient = useQueryClient();
    const serializedQueryKey = JSON.stringify(queryKey);
    useEffect(() => {
        if (isActive) return;
        void cancelViewContainerQuery(
            queryClient,
            JSON.parse(serializedQueryKey) as readonly unknown[],
        );
    }, [isActive, queryClient, serializedQueryKey]);
}

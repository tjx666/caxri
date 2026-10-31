/**
 * E2E-only seam for `SurfaceErrorBoundary` (`surface-error-boundary.tsx`): `sessionStorage` key whose value names a
 * surface scope, making the first surface of that scope that renders afterwards throw, so an E2E can prove that one
 * failing Chat entry, Terminal, Settings page, or view stays local without a real defect. The key is consumed when
 * claimed; the claimed surface keeps throwing until its boundary's Retry releases it, so React's re-render of a
 * throwing component and StrictMode's double render agree, while every other surface of the scope renders normally.
 */
export const SURFACE_FAULT_KEY = 'caxri.test.surface-fault';

/**
 * Surface scopes a boundary can guard. A closed set: it names the boundary in the mirrored console log, which the
 * classification path keeps free of content, and selects the fault target.
 */
export type SurfaceScope =
    'chat' | 'chat-entry' | 'editor' | 'settings' | 'settings-page' | 'terminal' | 'view';

/**
 * Which surface instance currently holds the armed fault, as `scope:instanceKey`.
 */
export interface SurfaceFaultMemo {
    claimed?: string;
}

/**
 * Decides whether the surface `scope:instanceKey` must throw now. Claims and clears {@link SURFACE_FAULT_KEY} when it
 * names `scope` and no surface holds the fault yet.
 */
export function shouldFailSurface(
    storage: Pick<Storage, 'getItem' | 'removeItem'>,
    memo: SurfaceFaultMemo,
    scope: SurfaceScope,
    instanceKey: string,
): boolean {
    const identity = `${scope}:${instanceKey}`;
    if (memo.claimed !== undefined) return memo.claimed === identity;
    if (storage.getItem(SURFACE_FAULT_KEY) !== scope) return false;
    storage.removeItem(SURFACE_FAULT_KEY);
    memo.claimed = identity;
    return true;
}

/**
 * Releases the fault held by `scope:instanceKey`, so the boundary's Retry renders the surface normally.
 */
export function releaseSurfaceFault(
    memo: SurfaceFaultMemo,
    scope: SurfaceScope,
    instanceKey: string,
): void {
    if (memo.claimed === `${scope}:${instanceKey}`) memo.claimed = undefined;
}

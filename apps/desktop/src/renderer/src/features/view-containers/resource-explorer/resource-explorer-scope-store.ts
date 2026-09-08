import { create } from 'zustand';

import { queryClient } from '../../../queries/client';
import { useWorkbenchStore } from '../../../stores/workbench';
import {
    knownDirectoryChildrenFromQueries,
    scopedValue,
    setScopedPathExpanded,
    setScopedSubtreeExpanded,
    setScopedValue,
} from './resource-explorer-state';

/**
 * Per-Session tree state (`scopeId` is `sessionId:workbenchProjectId`) for the Files view. It lives in a store rather
 * than in the controller's `useState` so each row can subscribe to its own boolean (expanded / selected / focus
 * requested) instead of receiving the whole tree's `Set` and selection as props: with 229 visible rows a single toggle
 * used to re-render every row, and a session switch rebuilt the entire tree.
 */
interface ResourceExplorerScopeState {
    expandedByScope: Record<string, string[]>;
    focusByScope: Record<string, string | undefined>;
    selectionByScope: Record<string, string | undefined>;
}

export const useResourceExplorerScopeStore = create<ResourceExplorerScopeState>(() => ({
    expandedByScope: {},
    focusByScope: {},
    selectionByScope: {},
}));

export function useIsPathExpanded(scopeId: string, path: string): boolean {
    return useResourceExplorerScopeStore(
        (state) => scopedValue(state.expandedByScope, scopeId)?.includes(path) ?? false,
    );
}

export function useIsPathSelected(scopeId: string, path: string): boolean {
    return useResourceExplorerScopeStore((state) => state.selectionByScope[scopeId] === path);
}

export function useHasScopeSelection(scopeId: string): boolean {
    return useResourceExplorerScopeStore((state) => state.selectionByScope[scopeId] !== undefined);
}

export function useIsPathFocusRequested(scopeId: string, path: string): boolean {
    return useResourceExplorerScopeStore((state) => state.focusByScope[scopeId] === path);
}

export function setScopeSelectedPath(scopeId: string, path: string | undefined): void {
    useResourceExplorerScopeStore.setState((state) => ({
        selectionByScope: setScopedValue(state.selectionByScope, scopeId, path),
    }));
}

export function setScopeFocusPath(scopeId: string, path: string | undefined): void {
    useResourceExplorerScopeStore.setState((state) =>
        state.focusByScope[scopeId] === path
            ? state
            : { focusByScope: setScopedValue(state.focusByScope, scopeId, path) },
    );
}

export function setScopePathExpanded(
    scopeId: string,
    path: string,
    isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean),
): void {
    useResourceExplorerScopeStore.setState((state) => ({
        expandedByScope: setScopedPathExpanded(
            state.expandedByScope,
            scopeId,
            path,
            isNextExpanded,
        ),
    }));
}

/**
 * Recursive (Alt-click) expansion only visits directories whose listing React Query already holds for this Project, so
 * it never expands into paths the tree has not loaded.
 */
export function setScopeSubtreeExpanded(
    scopeId: string,
    viewId: string,
    projectId: string,
    path: string,
    isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean),
): void {
    const knownChildren = knownDirectoryChildrenFromQueries(
        queryClient
            .getQueryCache()
            .findAll({ queryKey: ['viewContainers.viewOperation'] })
            .map((query) => ({
                data: query.state.data,
                isInvalidated: query.state.isInvalidated,
                queryKey: query.queryKey,
            })),
        viewId,
        projectId,
    );
    useResourceExplorerScopeStore.setState((state) => {
        const isCurrentExpanded =
            scopedValue(state.expandedByScope, scopeId)?.includes(path) ?? false;
        const isExpanded =
            typeof isNextExpanded === 'function'
                ? isNextExpanded(isCurrentExpanded)
                : isNextExpanded;
        return {
            expandedByScope: setScopedSubtreeExpanded(
                state.expandedByScope,
                scopeId,
                path,
                knownChildren,
                isExpanded,
            ),
        };
    });
}

export function collapseScope(scopeId: string): void {
    useResourceExplorerScopeStore.setState((state) => ({
        expandedByScope: setScopedValue(state.expandedByScope, scopeId, []),
    }));
}

/**
 * A row that receives real focus cancels a pending programmatic focus request aimed at another path, so a stale request
 * cannot yank focus later.
 */
export function clearStaleScopeFocusPath(scopeId: string, focusedPath: string): void {
    const pending = useResourceExplorerScopeStore.getState().focusByScope[scopeId];
    if (pending !== undefined && pending !== focusedPath) setScopeFocusPath(scopeId, undefined);
}

function withoutScopes<Value>(
    record: Record<string, Value>,
    isStale: (scopeId: string) => boolean,
): Record<string, Value> {
    const staleIds = Object.keys(record).filter((scopeId) => isStale(scopeId));
    if (staleIds.length === 0) return record;
    const next = { ...record };
    for (const scopeId of staleIds) delete next[scopeId];
    return next;
}

/**
 * Drops the tree state of Sessions that no longer exist. The Files view stays mounted for the app's lifetime, so
 * without this every archived or deleted Session would keep its expanded paths resident until restart.
 */
export function pruneResourceExplorerScopes(liveSessionIds: ReadonlySet<string>): void {
    const isStale = (scopeId: string): boolean =>
        !liveSessionIds.has(scopeId.slice(0, scopeId.indexOf(':')));
    useResourceExplorerScopeStore.setState((state) => {
        const expandedByScope = withoutScopes(state.expandedByScope, isStale);
        const focusByScope = withoutScopes(state.focusByScope, isStale);
        const selectionByScope = withoutScopes(state.selectionByScope, isStale);
        return expandedByScope === state.expandedByScope &&
            focusByScope === state.focusByScope &&
            selectionByScope === state.selectionByScope
            ? state
            : { expandedByScope, focusByScope, selectionByScope };
    });
}

/**
 * Prunes whenever the bootstrap Session list changes. Started by the Files controller so the subscription lives exactly
 * as long as a Files view exists.
 */
export function subscribeResourceExplorerScopePruning(): () => void {
    return useWorkbenchStore.subscribe((state, previous) => {
        const sessions = state.bootstrap?.sessions;
        if (!sessions || sessions === previous.bootstrap?.sessions) return;
        pruneResourceExplorerScopes(new Set(sessions.map((session) => session.id)));
    });
}

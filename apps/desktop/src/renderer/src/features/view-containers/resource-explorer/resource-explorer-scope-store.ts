import { isPathAtOrBelow } from '@caxri/protocol';

import { parentDirectoryPath } from '../../../lib/file-path';
import { createStore } from '../../../lib/store';
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
 * Identifies the Session whose tree the mounted Files view currently draws.
 */
export interface ResourceExplorerActiveScope {
    projectId: string;
    /**
     * `sessionId:workbenchProjectId`; keys every per-Session record below.
     */
    scopeId: string;
    sessionId: string;
}

/**
 * Per-Session tree state (`scopeId` is `sessionId:workbenchProjectId`) for the Files view. It lives in a store rather
 * than in the controller's `useState` so each row can subscribe to its own boolean (expanded / selected / focus
 * requested) instead of receiving the whole tree's `Set` and selection as props: with 229 visible rows a single toggle
 * used to re-render every row, and a session switch rebuilt the entire tree.
 *
 * `activeScope` lives here for the same reason, one level up. While a row received its `scopeId` and `sessionId` as
 * props, a Session switch changed both on all 49 visible rows and re-rendered every one of them plus its context-menu
 * wrappers (roughly 550 of the 699 component updates one switch cost) even though the booleans a row actually draws
 * from were usually identical in the new scope. Reading the scope from the store instead lets the same subscriptions
 * decide: a row re-renders on a Session switch only when its own expanded/selected/focus state really differs. Rows
 * never render the scope itself; they need it only inside event handlers and effects, which read it on demand.
 *
 * One Files view exists at a time (the secondary sidebar's), so a single active scope is sufficient. A second
 * concurrent tree would need this widened to a per-view record.
 */
export interface ResourceExplorerScopeState {
    activeScope: ResourceExplorerActiveScope | undefined;
    expandedByScope: Record<string, string[]>;
    focusByScope: Record<string, string | undefined>;
    revealByScope: Record<string, { path: string; revision: number } | undefined>;
    selectionByScope: Record<string, string | undefined>;
}

export const useResourceExplorerScopeStore = createStore<ResourceExplorerScopeState>(
    'resource-explorer-scope',
    () => ({
        activeScope: undefined,
        expandedByScope: {},
        focusByScope: {},
        revealByScope: {},
        selectionByScope: {},
    }),
);

/**
 * Publishes the scope the tree draws. Called by the controller; rows and their handlers read it back through
 * {@link activeResourceExplorerScope} and the subscription hooks below.
 */
export function setResourceExplorerActiveScope(
    scope: ResourceExplorerActiveScope | undefined,
): void {
    useResourceExplorerScopeStore.setState((state) => {
        const current = state.activeScope;
        return current?.scopeId === scope?.scopeId &&
            current?.sessionId === scope?.sessionId &&
            current?.projectId === scope?.projectId
            ? state
            : { activeScope: scope };
    });
}

/**
 * Reads the current scope outside render: from an event handler or an effect. Deliberately not a hook: subscribing a
 * row to the scope identity would reintroduce exactly the Session-switch re-render this store exists to avoid.
 */
export function activeResourceExplorerScope(): ResourceExplorerActiveScope | undefined {
    return useResourceExplorerScopeStore.getState().activeScope;
}

/**
 * Everything one file-tree row draws from this store, as pure reads over a state snapshot.
 *
 * Exported so a test can assert what a Session switch does to an entire visible tree through the same code the rows
 * subscribe by. A test that re-implemented these selectors would keep passing after the real ones drifted, and the
 * property being protected here (that switching Session leaves an unchanged row's inputs untouched) is exactly the kind
 * that dies silently.
 */
export const rowSelectors = {
    isPathExpanded(state: ResourceExplorerScopeState, path: string): boolean {
        const { scopeId } = state.activeScope ?? {};
        return scopeId === undefined
            ? false
            : (scopedValue(state.expandedByScope, scopeId)?.includes(path) ?? false);
    },
    isPathFocusRequested(state: ResourceExplorerScopeState, path: string): boolean {
        const { scopeId } = state.activeScope ?? {};
        return scopeId !== undefined && state.focusByScope[scopeId] === path;
    },
    isPathSelected(state: ResourceExplorerScopeState, path: string): boolean {
        const { scopeId } = state.activeScope ?? {};
        return scopeId !== undefined && state.selectionByScope[scopeId] === path;
    },
    hasScopeSelection(state: ResourceExplorerScopeState): boolean {
        const { scopeId } = state.activeScope ?? {};
        return scopeId !== undefined && state.selectionByScope[scopeId] !== undefined;
    },
};

export function useIsPathExpanded(path: string): boolean {
    return useResourceExplorerScopeStore((state) => rowSelectors.isPathExpanded(state, path));
}

export function useIsPathSelected(path: string): boolean {
    return useResourceExplorerScopeStore((state) => rowSelectors.isPathSelected(state, path));
}

export function useHasScopeSelection(): boolean {
    return useResourceExplorerScopeStore((state) => rowSelectors.hasScopeSelection(state));
}

export function useIsPathFocusRequested(path: string): boolean {
    return useResourceExplorerScopeStore((state) => rowSelectors.isPathFocusRequested(state, path));
}

/**
 * The active scope's pending reveal request. The tree, not a row, consumes it: the revealed row may sit outside the
 * virtualized window, so only the tree can scroll it into view.
 */
export function useActiveRevealRequest(): { path: string; revision: number } | undefined {
    return useResourceExplorerScopeStore((state) => {
        const { scopeId } = state.activeScope ?? {};
        return scopeId === undefined ? undefined : state.revealByScope[scopeId];
    });
}

/**
 * The active scope's selected path, which the tree keeps mounted so the roving Tab stop survives scrolling.
 */
export function useActiveSelectedPath(): string | undefined {
    return useResourceExplorerScopeStore((state) => {
        const { scopeId } = state.activeScope ?? {};
        return scopeId === undefined ? undefined : state.selectionByScope[scopeId];
    });
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

/**
 * Reveals a Project entry without moving keyboard focus: every ancestor directory becomes expanded, the entry becomes
 * the tree selection, and a revision tells the tree to scroll that row into view once its listing has loaded. Existing
 * disclosure state is merged rather than replaced so following the Editor never collapses a branch the user opened
 * explicitly.
 */
export function didRevealPathInScope(scopeId: string, projectRoot: string, path: string): boolean {
    if (path === projectRoot || !isPathAtOrBelow(path, projectRoot)) return false;

    const ancestors: string[] = [];
    let current = parentDirectoryPath(path);
    while (current !== projectRoot) {
        if (!isPathAtOrBelow(current, projectRoot)) return false;
        ancestors.unshift(current);
        current = parentDirectoryPath(current);
    }

    useResourceExplorerScopeStore.setState((state) => {
        const expanded = new Set(state.expandedByScope[scopeId]);
        for (const ancestor of ancestors) expanded.add(ancestor);
        return {
            expandedByScope: setScopedValue(state.expandedByScope, scopeId, [...expanded]),
            revealByScope: setScopedValue(state.revealByScope, scopeId, {
                path,
                revision: (state.revealByScope[scopeId]?.revision ?? 0) + 1,
            }),
            selectionByScope: setScopedValue(state.selectionByScope, scopeId, path),
        };
    });
    return true;
}

/**
 * Reveals a directory the user asked for by name (a clicked path link): like {@link didRevealPathInScope}, and the
 * directory itself is expanded too, so its contents are visible rather than only its row. Returns `false` for the
 * Project root or a path outside it, which have no row to reveal.
 */
export function didRevealDirectoryInScope(
    scopeId: string,
    projectRoot: string,
    path: string,
): boolean {
    if (!didRevealPathInScope(scopeId, projectRoot, path)) return false;
    setScopePathExpanded(scopeId, path, true);
    return true;
}

/**
 * Follows the Editor: reveals the file the active work tab shows, or drops the pending reveal when that tab shows no
 * Project file (a Terminal, a diff, an external file), so a stale request cannot scroll the tree after the user moved
 * on.
 *
 * `isInitial` marks the follower's first run, when the Files view has just become visible. A reveal already pending at
 * that moment was requested for this very view opening (a clicked directory link raises Files and reveals in one step),
 * so the Editor must not replace or drop it.
 */
export function followEditorFileInScope(
    scopeId: string,
    projectRoot: string,
    activeFilePath: string | undefined,
    { isInitial = false }: { isInitial?: boolean } = {},
): void {
    if (isInitial && useResourceExplorerScopeStore.getState().revealByScope[scopeId] !== undefined)
        return;
    if (activeFilePath === undefined || !didRevealPathInScope(scopeId, projectRoot, activeFilePath))
        clearScopeRevealPath(scopeId);
}

/**
 * Clears a one-shot reveal request. A row supplies the token it consumed so it cannot erase a newer request that won
 * between render and its effect; callers invalidating the whole scope omit the token.
 */
export function clearScopeRevealPath(
    scopeId: string,
    expected?: { path: string; revision: number },
): void {
    useResourceExplorerScopeStore.setState((state) => {
        const current = state.revealByScope[scopeId];
        if (
            current === undefined ||
            (expected !== undefined &&
                (current.path !== expected.path || current.revision !== expected.revision))
        )
            return state;
        return {
            revealByScope: setScopedValue(state.revealByScope, scopeId, undefined),
        };
    });
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
        const revealByScope = withoutScopes(state.revealByScope, isStale);
        const selectionByScope = withoutScopes(state.selectionByScope, isStale);
        // A Session deleted while its tree was on screen leaves the controller no render in which to republish, so the
        // stale scope is dropped here too rather than left pointing at records this very call just removed.
        const activeScope =
            state.activeScope && !liveSessionIds.has(state.activeScope.sessionId)
                ? undefined
                : state.activeScope;
        return activeScope === state.activeScope &&
            expandedByScope === state.expandedByScope &&
            focusByScope === state.focusByScope &&
            revealByScope === state.revealByScope &&
            selectionByScope === state.selectionByScope
            ? state
            : { activeScope, expandedByScope, focusByScope, revealByScope, selectionByScope };
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

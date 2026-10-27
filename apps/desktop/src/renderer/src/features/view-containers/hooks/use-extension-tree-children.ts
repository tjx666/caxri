import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TreeItemDto } from '@caxri/protocol';
import { useQueryClient } from '@tanstack/react-query';

import { caxri } from '../../../lib/caxri';
import { isCancelledRequest } from '../../../stores/toasts';
import type { ExtensionTreeScope } from '../extension-tree-client';
import {
    cacheTreeChildren,
    cancelTreeChildrenRequest,
    clearCachedTreeChildren,
    readCachedTreeChildren,
    removeCachedTreeChildren,
    requestTreeChildren,
    ROOT_HANDLE,
} from '../extension-tree-client';
import type { RootLoadProgress } from '../extension-tree-refresh-state';
import type { ExtensionTreeState, TreeSnapshot } from '../extension-tree-state';
import {
    completeTreeSnapshot,
    focusTreeItem,
    isTreeSnapshotReady,
    nextTreeSnapshot,
    reconcileTreeItems,
    replaceTreeChildren,
    visibleTreeLoading,
} from '../extension-tree-state';
import { useIsViewContainerActive } from '../view-container-activity';

type UpdateExtensionTreeState = (
    update: (current: ExtensionTreeState) => ExtensionTreeState,
) => void;

/**
 * Owns the lazily loaded children/error/loading state for one Extension Tree View: fetches a branch's children on
 * demand, cancels superseded requests, replays server-driven refreshes, and keeps `treeState` (focus/expansion)
 * reconciled against whatever the provider last returned. Extracted out of `ExtensionTreeViewContent` so that component
 * stays focused on rendering and keyboard handling.
 */
export function useExtensionTreeChildren(
    scope: ExtensionTreeScope,
    updateTreeState: UpdateExtensionTreeState,
    treeState: ExtensionTreeState,
): {
    children: ReadonlyMap<string, readonly TreeItemDto[]>;
    errors: ReadonlyMap<string, string>;
    loading: ReadonlySet<string>;
    loadChildren: (parentHandle: string) => Promise<void>;
    requests: RefObject<Map<string, string>>;
    rootLoads: RootLoadProgress;
    visibleChildren: ReadonlyMap<string, readonly TreeItemDto[]>;
    visibleErrors: ReadonlyMap<string, string>;
    visibleLoading: ReadonlySet<string>;
} {
    const queryClient = useQueryClient();
    const isActive = useIsViewContainerActive();
    const requests = useRef(new Map<string, string>());
    const rootLoadRevision = useRef(0);
    /**
     * A remount re-enters the view with whatever this scope last loaded: the component is keyed by Session, so
     * switching Sessions and back would otherwise rebuild the tree from an empty state even though the cache still
     * holds the branches. The root reload below runs either way, so a restored branch is only ever on screen while its
     * replacement is in flight.
     */
    const [restoredChildren] = useState(() => readCachedTreeChildren(queryClient, scope));
    const childrenReference = useRef<ReadonlyMap<string, readonly TreeItemDto[]>>(restoredChildren);
    const [children, setChildren] =
        useState<ReadonlyMap<string, readonly TreeItemDto[]>>(restoredChildren);
    const [rootLoads, setRootLoads] = useState<RootLoadProgress>({ completed: 0, started: 0 });
    const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
    const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set([ROOT_HANDLE]));
    const [snapshot, setSnapshot] = useState<TreeSnapshot | undefined>(() =>
        restoredChildren.size > 0
            ? completeTreeSnapshot(restoredChildren, new Map<string, string>())
            : undefined,
    );
    const snapshotReady = isTreeSnapshotReady(ROOT_HANDLE, children, errors, loading, treeState);
    /**
     * Keep the last complete tree (or, before the first one, the partial tree already shown) on screen while opaque
     * handles and expanded descendants are rebuilt. The working tree remains separate so lazy loading never uses
     * retired display handles.
     *
     * Adjusted during render rather than from an effect
     * (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes). React restarts
     * this render before painting, so the snapshot agrees with the tree in the same frame. From an effect the user
     * would instead see one frame where the refresh has finished but the screen still shows the pre-refresh tree.
     */
    const nextSnapshot = nextTreeSnapshot(
        snapshot,
        ROOT_HANDLE,
        children,
        errors,
        loading,
        snapshotReady,
    );
    if (nextSnapshot !== snapshot) setSnapshot(nextSnapshot);
    const visibleLoading = useMemo(
        () => visibleTreeLoading(loading, snapshot),
        [loading, snapshot],
    );

    const replaceLoadedChildren = useCallback(
        (parentHandle: string, items: readonly TreeItemDto[]): void => {
            const replacement = replaceTreeChildren(childrenReference.current, parentHandle, items);
            childrenReference.current = replacement.children;
            setChildren(replacement.children);
            cacheTreeChildren(queryClient, scope, parentHandle, items);
            if (replacement.retiredHandles.size === 0) return;

            removeCachedTreeChildren(queryClient, scope, replacement.retiredHandles);
            for (const handle of replacement.retiredHandles) {
                const requestId = requests.current.get(handle);
                if (!requestId) continue;
                requests.current.delete(handle);
                cancelTreeChildrenRequest(requestId);
            }
            setErrors((current) => {
                const next = new Map(current);
                for (const handle of replacement.retiredHandles) next.delete(handle);
                return next;
            });
            setLoading((current) => {
                const next = new Set(current);
                for (const handle of replacement.retiredHandles) next.delete(handle);
                return next;
            });
        },
        [queryClient, scope],
    );

    const resetLoadedChildren = useCallback((): void => {
        for (const requestId of requests.current.values()) cancelTreeChildrenRequest(requestId);
        requests.current.clear();
        const empty = new Map<string, readonly TreeItemDto[]>();
        childrenReference.current = empty;
        setChildren(empty);
        setErrors(new Map());
        setLoading(new Set());
        clearCachedTreeChildren(queryClient, scope);
    }, [queryClient, scope]);

    const loadChildren = useCallback(
        async (parentHandle: string): Promise<void> => {
            if (!isActive) return;
            if (
                parentHandle !== ROOT_HANDLE &&
                childrenReference.current
                    .values()
                    .every((items) => items.every((item) => item.handle !== parentHandle))
            )
                return;
            const currentRootLoad =
                parentHandle === ROOT_HANDLE ? (rootLoadRevision.current += 1) : undefined;
            if (currentRootLoad !== undefined)
                setRootLoads((current) => ({ ...current, started: currentRootLoad }));
            const previousRequestId = requests.current.get(parentHandle);
            if (previousRequestId) cancelTreeChildrenRequest(previousRequestId);
            const requestId = crypto.randomUUID();
            requests.current.set(parentHandle, requestId);
            setLoading((current) => new Set(current).add(parentHandle));
            setErrors((current) => {
                const next = new Map(current);
                next.delete(parentHandle);
                return next;
            });
            // Settled into a value instead of try/catch/finally: React Compiler cannot lower `finally`, and the cleanup
            // below must run for success, failure, and a superseded request alike.
            let outcome:
                | { ok: true; result: Awaited<ReturnType<typeof requestTreeChildren>> }
                | { ok: false; error: unknown };
            try {
                outcome = {
                    ok: true,
                    result: await requestTreeChildren(scope, parentHandle, requestId),
                };
            } catch (error) {
                outcome = { ok: false, error };
            }
            if (requests.current.get(parentHandle) === requestId) {
                if (outcome.ok) {
                    const { result } = outcome;
                    if (result.reset) resetLoadedChildren();
                    const resultParentHandle = result.reset ? ROOT_HANDLE : parentHandle;
                    replaceLoadedChildren(resultParentHandle, result.items);
                    updateTreeState((current) => {
                        let next = reconcileTreeItems(current, result.items);
                        if (
                            resultParentHandle === ROOT_HANDLE &&
                            !next.focusedKey &&
                            result.items[0]
                        )
                            next = focusTreeItem(next, result.items[0]);
                        return next;
                    });
                } else if (!isCancelledRequest(outcome.error)) {
                    /**
                     * CANCELLED (skipped above) means this tree's Session scope was retired on the Server: the view is
                     * being retired, so the read is superseded rather than failed and must not paint an error into the
                     * branch.
                     */
                    const { error } = outcome;
                    setErrors((current) =>
                        new Map(current).set(
                            parentHandle,
                            error instanceof Error ? error.message : String(error),
                        ),
                    );
                }
            }
            if (requests.current.get(parentHandle) === requestId) {
                requests.current.delete(parentHandle);
                if (currentRootLoad !== undefined)
                    setRootLoads((current) => ({
                        ...current,
                        completed: Math.max(current.completed, currentRootLoad),
                    }));
                setLoading((current) => {
                    const next = new Set(current);
                    next.delete(parentHandle);
                    return next;
                });
            }
        },
        [isActive, replaceLoadedChildren, resetLoadedChildren, scope, updateTreeState],
    );

    useEffect(() => {
        // Hidden keep-alive trees keep their last children on screen and drop in-flight provider work. Showing the
        // container again revalidates the root so treeChanged events that arrived while hidden are not lost.
        if (!isActive) {
            const cancelledHandles = requests.current.keys().toArray();
            for (const requestId of requests.current.values()) cancelTreeChildrenRequest(requestId);
            requests.current.clear();
            if (cancelledHandles.length === 0) return;
            setLoading((current) => {
                const next = new Set(current);
                for (const handle of cancelledHandles) next.delete(handle);
                return next;
            });
            return;
        }
        void loadChildren(ROOT_HANDLE);
        const unsubscribe = caxri.onEvent((event) => {
            if (
                event.event !== 'viewContainers.treeChanged' ||
                event.payload.viewId !== scope.viewId ||
                event.payload.extensionGeneration !== scope.extensionGeneration ||
                event.payload.context.kind !== 'session' ||
                event.payload.context.sessionId !== scope.sessionId ||
                event.payload.context.workbenchRootProjectId !== scope.workbenchRootProjectId
            )
                return;
            if (!event.payload.handles) {
                resetLoadedChildren();
                void loadChildren(ROOT_HANDLE);
                return;
            }
            const handles = event.payload.handles;
            for (const handle of handles) {
                void loadChildren(handle);
            }
        });
        const activeRequests = requests.current;
        return () => {
            unsubscribe();
            for (const requestId of activeRequests.values()) cancelTreeChildrenRequest(requestId);
            activeRequests.clear();
        };
    }, [isActive, loadChildren, resetLoadedChildren, scope]);

    return {
        children,
        errors,
        loading,
        loadChildren,
        requests,
        rootLoads,
        visibleChildren: snapshotReady ? children : (snapshot?.children ?? children),
        visibleErrors: snapshotReady ? errors : (snapshot?.errors ?? errors),
        visibleLoading,
    };
}

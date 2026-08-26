import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { TreeItemDto } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import type { ExtensionTreeState } from './extension-tree-state';
import { focusTreeItem, reconcileTreeItems, replaceTreeChildren } from './extension-tree-state';

export const ROOT_HANDLE = '__caxri_tree_root__';

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
    scope: {
        viewId: string;
        sessionId: string;
        workbenchProjectId: string;
        extensionGeneration: number;
    },
    updateTreeState: UpdateExtensionTreeState,
): {
    children: ReadonlyMap<string, readonly TreeItemDto[]>;
    errors: ReadonlyMap<string, string>;
    loading: ReadonlySet<string>;
    loadChildren: (parentHandle: string) => Promise<void>;
    requests: RefObject<Map<string, string>>;
} {
    const requests = useRef(new Map<string, string>());
    const childrenReference = useRef<ReadonlyMap<string, readonly TreeItemDto[]>>(new Map());
    const [children, setChildren] = useState<ReadonlyMap<string, readonly TreeItemDto[]>>(
        () => childrenReference.current,
    );
    const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
    const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set([ROOT_HANDLE]));

    const replaceLoadedChildren = useCallback(
        (parentHandle: string, items: readonly TreeItemDto[]): void => {
            const replacement = replaceTreeChildren(childrenReference.current, parentHandle, items);
            childrenReference.current = replacement.children;
            setChildren(replacement.children);
            if (replacement.retiredHandles.size === 0) return;

            for (const handle of replacement.retiredHandles) {
                const requestId = requests.current.get(handle);
                if (!requestId) continue;
                requests.current.delete(handle);
                // eslint-disable-next-line no-void -- refreshed descendants invalidate their in-flight requests
                void caxri.request('viewContainers.cancelRequest', { requestId });
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
        [],
    );

    const resetLoadedChildren = useCallback((): void => {
        for (const requestId of requests.current.values()) {
            // eslint-disable-next-line no-void -- a root refresh invalidates every in-flight branch request
            void caxri.request('viewContainers.cancelRequest', { requestId });
        }
        requests.current.clear();
        const empty = new Map<string, readonly TreeItemDto[]>();
        childrenReference.current = empty;
        setChildren(empty);
        setErrors(new Map());
        setLoading(new Set());
    }, []);

    const loadChildren = useCallback(
        async (parentHandle: string): Promise<void> => {
            const previousRequestId = requests.current.get(parentHandle);
            if (previousRequestId) {
                // eslint-disable-next-line no-void -- cancellation is best-effort and the next request owns loading state
                void caxri.request('viewContainers.cancelRequest', {
                    requestId: previousRequestId,
                });
            }
            const requestId = crypto.randomUUID();
            requests.current.set(parentHandle, requestId);
            setLoading((current) => new Set(current).add(parentHandle));
            setErrors((current) => {
                const next = new Map(current);
                next.delete(parentHandle);
                return next;
            });
            try {
                const result = await caxri.request('viewContainers.treeChildren', {
                    viewId: scope.viewId,
                    requestId,
                    ...(parentHandle !== ROOT_HANDLE && { parentHandle }),
                });
                if (requests.current.get(parentHandle) !== requestId) return;
                if (result.reset) resetLoadedChildren();
                const resultParentHandle = result.reset ? ROOT_HANDLE : parentHandle;
                replaceLoadedChildren(resultParentHandle, result.items);
                updateTreeState((current) => {
                    let next = reconcileTreeItems(current, result.items);
                    if (resultParentHandle === ROOT_HANDLE && !next.focusedKey && result.items[0])
                        next = focusTreeItem(next, result.items[0]);
                    return next;
                });
            } catch (error) {
                if (requests.current.get(parentHandle) !== requestId) return;
                setErrors((current) =>
                    new Map(current).set(
                        parentHandle,
                        error instanceof Error ? error.message : String(error),
                    ),
                );
            } finally {
                if (requests.current.get(parentHandle) === requestId) {
                    requests.current.delete(parentHandle);
                    setLoading((current) => {
                        const next = new Set(current);
                        next.delete(parentHandle);
                        return next;
                    });
                }
            }
        },
        [replaceLoadedChildren, resetLoadedChildren, scope, updateTreeState],
    );

    useEffect(() => {
        // eslint-disable-next-line no-void -- the loader reports failures in the tree's error row
        void loadChildren(ROOT_HANDLE);
        const unsubscribe = caxri.onEvent((event) => {
            if (
                event.event !== 'viewContainers.treeChanged' ||
                event.payload.viewId !== scope.viewId ||
                event.payload.extensionGeneration !== scope.extensionGeneration ||
                event.payload.context.kind !== 'session' ||
                event.payload.context.sessionId !== scope.sessionId ||
                event.payload.context.workbenchProjectId !== scope.workbenchProjectId
            )
                return;
            if (!event.payload.handles) {
                resetLoadedChildren();
                // eslint-disable-next-line no-void -- the loader reports failures in the tree's error row
                void loadChildren(ROOT_HANDLE);
                return;
            }
            const handles = event.payload.handles;
            for (const handle of handles) {
                // eslint-disable-next-line no-void -- each changed branch reports failures in the tree's error row
                void loadChildren(handle);
            }
        });
        const activeRequests = requests.current;
        return () => {
            unsubscribe();
            for (const requestId of activeRequests.values()) {
                // eslint-disable-next-line no-void -- cancellation is best-effort during unmount
                void caxri.request('viewContainers.cancelRequest', { requestId });
            }
            activeRequests.clear();
        };
    }, [loadChildren, resetLoadedChildren, scope]);

    return { children, errors, loading, loadChildren, requests };
}

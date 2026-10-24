import type { TreeChildrenResult, TreeItemDto } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxri } from '../../lib/caxri';
import { EXTENSION_TREE_CHILDREN_QUERY_METHOD } from '../../queries/client';

/**
 * Sentinel parent for a view's root branch. The wire contract omits `parentHandle` for the root, so the sentinel never
 * leaves the Renderer; it exists so the loaded-branch map and the query cache can key the root like any other branch.
 */
export const ROOT_HANDLE = '__caxri_tree_root__';

/**
 * Identifies the Extension Tree View a cached branch belongs to. The Extension generation is part of the identity
 * because tree handles are opaque provider tokens: a reloaded Extension Host retires every handle it issued, so a
 * generation bump must start from an empty cache instead of replaying handles the provider no longer knows.
 */
export interface ExtensionTreeScope {
    extensionGeneration: number;
    sessionId: string;
    viewId: string;
    workbenchProjectId: string;
}

interface ExtensionTreeChildrenQueryParameters {
    contextKey: string;
    parentHandle: string;
    viewId: string;
}

/**
 * Extends the `${sessionId}:${workbenchProjectId}` context key that controlled views already use with the Extension
 * generation, so `removeSessionQueries` keeps matching a deleted Session by its `${sessionId}:` prefix.
 */
function extensionTreeContextKey(scope: ExtensionTreeScope): string {
    return `${scope.sessionId}:${scope.workbenchProjectId}:${scope.extensionGeneration}`;
}

/**
 * The one place a branch's cache key is built. Keeping it module-private is the point of this file: every read, write,
 * and removal below goes through it, so no call site can invent a key shape that a later sweep fails to match.
 */
function extensionTreeChildrenQueryKey(
    scope: ExtensionTreeScope,
    parentHandle: string,
): readonly [string, ExtensionTreeChildrenQueryParameters] {
    return [
        EXTENSION_TREE_CHILDREN_QUERY_METHOD,
        { contextKey: extensionTreeContextKey(scope), parentHandle, viewId: scope.viewId },
    ] as const;
}

function treeChildrenQueryParameters(
    queryKey: readonly unknown[],
): ExtensionTreeChildrenQueryParameters | undefined {
    const [method, rawParameters] = queryKey;
    if (
        method !== EXTENSION_TREE_CHILDREN_QUERY_METHOD ||
        typeof rawParameters !== 'object' ||
        rawParameters === null
    )
        return undefined;
    const parameters = rawParameters as Partial<ExtensionTreeChildrenQueryParameters>;
    return typeof parameters.contextKey === 'string' &&
        typeof parameters.parentHandle === 'string' &&
        typeof parameters.viewId === 'string'
        ? (parameters as ExtensionTreeChildrenQueryParameters)
        : undefined;
}

function isScopedTreeChildrenQuery(
    queryKey: readonly unknown[],
    scope: ExtensionTreeScope,
): boolean {
    const parameters = treeChildrenQueryParameters(queryKey);
    return (
        parameters?.viewId === scope.viewId &&
        parameters.contextKey === extensionTreeContextKey(scope)
    );
}

/**
 * Reads one branch from the provider. Cancellation stays on the provider's own `requestId` protocol rather than an
 * `AbortSignal`, because the tree supersedes a branch request from several independent places (a refresh, a retired
 * ancestor, a collapse) and the Extension Host needs the id to drop the superseded work.
 */
export function requestTreeChildren(
    scope: ExtensionTreeScope,
    parentHandle: string,
    requestId: string,
): Promise<TreeChildrenResult> {
    return caxri.request('viewContainers.treeChildren', {
        viewId: scope.viewId,
        requestId,
        /**
         * Server Core rejects the read with CANCELLED once this Session is deleted or its Workbench Root changes, so a
         * branch computed for a retired scope can never be delivered into this tree.
         */
        context: {
            kind: 'session',
            sessionId: scope.sessionId,
            workbenchProjectId: scope.workbenchProjectId,
        },
        ...(parentHandle !== ROOT_HANDLE && { parentHandle }),
    });
}

export function cancelTreeChildrenRequest(requestId: string): void {
    void caxri.request('viewContainers.cancelRequest', { requestId });
}

/**
 * Restores the branches this scope last loaded. Mounting a tree with the previous result already in hand is what keeps
 * switching back to a Session from rebuilding the whole view from an empty state; the mount still revalidates the root
 * immediately, so the restored tree is only ever shown while the fresh one is in flight.
 */
export function readCachedTreeChildren(
    queryClient: QueryClient,
    scope: ExtensionTreeScope,
): ReadonlyMap<string, readonly TreeItemDto[]> {
    const cached = queryClient.getQueriesData<readonly TreeItemDto[]>({
        predicate: ({ queryKey }) => isScopedTreeChildrenQuery(queryKey, scope),
    });
    const children = new Map<string, readonly TreeItemDto[]>();
    for (const [queryKey, items] of cached) {
        const parameters = treeChildrenQueryParameters(queryKey);
        if (parameters && items) children.set(parameters.parentHandle, items);
    }
    return children;
}

/**
 * The tree runtime owns fetching (opaque handles, provider-driven resets, per-branch cancellation), so branches are
 * written into the shared cache rather than fetched through a `queryFn`. Keeping them in the same cache as every other
 * server read is what gives them Session-scoped keys, one garbage-collection policy, and one place to sweep a deleted
 * Session from.
 */
export function cacheTreeChildren(
    queryClient: QueryClient,
    scope: ExtensionTreeScope,
    parentHandle: string,
    items: readonly TreeItemDto[],
): void {
    queryClient.setQueryData(extensionTreeChildrenQueryKey(scope, parentHandle), items);
}

export function removeCachedTreeChildren(
    queryClient: QueryClient,
    scope: ExtensionTreeScope,
    parentHandles: Iterable<string>,
): void {
    for (const parentHandle of parentHandles)
        queryClient.removeQueries({
            queryKey: extensionTreeChildrenQueryKey(scope, parentHandle),
            exact: true,
        });
}

export function clearCachedTreeChildren(queryClient: QueryClient, scope: ExtensionTreeScope): void {
    queryClient.removeQueries({
        predicate: ({ queryKey }) => isScopedTreeChildrenQuery(queryKey, scope),
    });
}

import type {
    ExtensionViewEventContext,
    ExtensionViewOperationName,
    SourceControlActionResult,
    SourceControlHistoryDetails,
    SourceControlHistoryPage,
    SourceControlViewModel,
} from '@caxri/protocol';
import { isExtensionViewReadOperation } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxri } from '../../lib/caxri';
import { CONTROLLED_VIEW_QUERY_METHOD } from '../../queries/client';
import { getSelectedSession } from '../../stores/selectors';

export interface SourceControlClient {
    readonly viewId: string;
    action(
        request: { actionId: string; revision: string },
        signal?: AbortSignal,
    ): Promise<SourceControlActionResult>;
    historyDetails(
        request: { historyId: string; itemId: string; path?: string; revision: string },
        signal?: AbortSignal,
    ): Promise<SourceControlHistoryDetails>;
    historyPage(
        request: {
            historyId: string;
            itemActivation?: 'action';
            offset: number;
            pageSize: number;
            path?: string;
            revision: string;
        },
        signal?: AbortSignal,
    ): Promise<SourceControlHistoryPage>;
    snapshot(
        request: {
            activeResource?: string;
            preferredModeId?: string;
            refresh: number;
            revision?: string;
        },
        signal?: AbortSignal,
    ): Promise<SourceControlViewModel>;
}

type ViewOperation = ExtensionViewOperationName;

/**
 * Every operation name {@link controlledViewQueryKey} can put in a cache key. Cache predicates match against this union
 * rather than bare strings so an operation that no controlled view produces cannot sit in a matcher forever without
 * matching anything (issue #799).
 */
export type ControlledViewQueryOperation = ViewOperation | 'files.list';

export function controlledViewQueryKey(
    viewId: string,
    operation: ControlledViewQueryOperation,
    arguments_: Record<string, unknown>,
    contextKey?: string,
    cacheRevision?: string,
) {
    return [
        CONTROLLED_VIEW_QUERY_METHOD,
        {
            viewId,
            operation,
            arguments: arguments_,
            ...(contextKey && { contextKey }),
            ...(cacheRevision && { cacheRevision }),
        },
    ] as const;
}

/**
 * Drops an in-flight `source.snapshot` before marking it stale. `invalidateQueries` reuses that promise, and Source
 * Control closes the refresh nonce over `queryFn`, so a Refresh during the cold fetch would otherwise land generation
 * 0.
 */
export async function invalidateControlledViewSnapshotQueries(
    queryClient: QueryClient,
    viewId: string,
): Promise<void> {
    const filters = {
        predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
            isControlledViewOperationQuery(queryKey, viewId, 'source.snapshot'),
    };
    await queryClient.cancelQueries(filters);
    await queryClient.invalidateQueries(filters);
}

export function isControlledViewOperationQuery(
    queryKey: readonly unknown[],
    viewId: string,
    operation: ControlledViewQueryOperation,
    isArgumentsMatch: (arguments_: Record<string, unknown>) => boolean = () => true,
): boolean {
    const [method, rawParameters] = queryKey;
    if (
        method !== 'viewContainers.viewOperation' ||
        typeof rawParameters !== 'object' ||
        rawParameters === null
    )
        return false;
    const parameters = rawParameters as {
        arguments?: unknown;
        operation?: unknown;
        viewId?: unknown;
    };
    return (
        parameters.viewId === viewId &&
        parameters.operation === operation &&
        typeof parameters.arguments === 'object' &&
        parameters.arguments !== null &&
        isArgumentsMatch(parameters.arguments as Record<string, unknown>)
    );
}

export async function viewOperation<Result>(
    viewId: string,
    context: ExtensionViewEventContext,
    operation: ViewOperation,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<Result> {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const cancel = (): void => {
        // The provider owns request cancellation; an already-authorized action may still complete exactly once.
        void caxri.request('viewContainers.cancelRequest', { requestId });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        const result = (await caxri.request('viewContainers.viewOperation', {
            viewId,
            requestId,
            context,
            operation,
            arguments: arguments_,
        } as never)) as Result;
        /**
         * Activation can still be in flight when cancellation reaches the Extension Host. Rejecting here is the final
         * generation-independent fence: a late read never enters React Query, while a provider action preserves its own
         * completion semantics.
         */
        if (isExtensionViewReadOperation(operation)) signal?.throwIfAborted();
        return result;
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
}

/**
 * Resolved per call rather than captured when the client is built, for the same reason as the Resource Explorer's
 * client: a captured Session would give the controlled-view context value a new identity on every switch and re-render
 * every consumer under it.
 */
export function currentViewEventContext(): ExtensionViewEventContext {
    const session = getSelectedSession();
    return session?.id && session.workbenchRootProjectId
        ? {
              kind: 'session',
              sessionId: session.id,
              workbenchRootProjectId: session.workbenchRootProjectId,
          }
        : { kind: 'no-session' };
}

export function createSourceControlClient(viewId: string): SourceControlClient {
    return {
        viewId,
        action: (request, signal) =>
            viewOperation(viewId, currentViewEventContext(), 'source.action', request, signal),
        historyDetails: (request, signal) =>
            viewOperation(
                viewId,
                currentViewEventContext(),
                'source.historyDetails',
                request,
                signal,
            ),
        historyPage: (request, signal) =>
            viewOperation(viewId, currentViewEventContext(), 'source.historyPage', request, signal),
        snapshot: (request, signal) =>
            viewOperation(viewId, currentViewEventContext(), 'source.snapshot', request, signal),
    };
}

import type {
    ExtensionViewEventContext,
    SourceControlActionResult,
    SourceControlHistoryDetails,
    SourceControlHistoryPage,
    SourceControlViewModel,
} from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxri } from '../../lib/caxri';

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

type ViewOperation =
    | 'badge.snapshot'
    | 'source.action'
    | 'source.historyDetails'
    | 'source.historyPage'
    | 'source.snapshot';

type ControlledViewQueryOperation = ViewOperation | 'files.list' | 'files.search';

export function controlledViewQueryKey(
    viewId: string,
    operation: ControlledViewQueryOperation,
    arguments_: Record<string, unknown>,
    contextKey?: string,
    cacheRevision?: string,
) {
    return [
        'viewContainers.viewOperation',
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
        // eslint-disable-next-line no-void -- cancellation is best-effort and the original request owns errors
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
        if (operation !== 'source.action') signal?.throwIfAborted();
        return result;
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
}

export function createSourceControlClient(
    viewId: string,
    context: ExtensionViewEventContext,
): SourceControlClient {
    return {
        viewId,
        action: (request, signal) =>
            viewOperation(viewId, context, 'source.action', request, signal),
        historyDetails: (request, signal) =>
            viewOperation(viewId, context, 'source.historyDetails', request, signal),
        historyPage: (request, signal) =>
            viewOperation(viewId, context, 'source.historyPage', request, signal),
        snapshot: (request, signal) =>
            viewOperation(viewId, context, 'source.snapshot', request, signal),
    };
}

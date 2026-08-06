import {
    useQuery,
    useQueryClient,
    type UseQueryOptions,
    type UseQueryResult,
} from '@tanstack/react-query';
import { useEffect } from 'react';

import type { CaxriMethod, MethodResult, ParamsArg } from '@shared/ipc';

import { caxri } from '../lib/caxri';
import { describeFailure, pushToast } from './toasts';

/** The single params argument a Caxri method accepts, or `undefined` for a no-params method. */
type MethodParams<M extends CaxriMethod> = ParamsArg<M>[0];

/**
 * Cache key for a Caxri read: the method name paired with its params, so distinct params (a
 * different Session, a different file path) never collide in the query cache. This is the "keyed
 * by method name + params" factory the server-state layer is built on — every read and every
 * targeted invalidation goes through it instead of an ad hoc string.
 */
export type CaxriQueryKey<M extends CaxriMethod> = readonly [M, MethodParams<M>];

export function caxriQueryKey<M extends CaxriMethod>(
    method: M,
    params: MethodParams<M>,
): CaxriQueryKey<M> {
    return [method, params] as CaxriQueryKey<M>;
}

/**
 * Typed `useQuery` over a Caxri RPC method. Full inference flows from the method table in
 * `@shared/ipc`: `params` must match the method's schema and the resolved data is `MethodResult<M>`,
 * with no `any` at any point. Callers gate an unavailable dependency (no Session selected, for
 * instance) with `enabled: false` rather than skipping the hook — the params value itself may be a
 * placeholder in that case, since a disabled query never runs `queryFn`.
 */
export function useCaxriQuery<M extends CaxriMethod>(
    method: M,
    params: MethodParams<M>,
    options?: Omit<
        UseQueryOptions<MethodResult<M>, Error, MethodResult<M>, CaxriQueryKey<M>>,
        'queryKey' | 'queryFn'
    >,
): UseQueryResult<MethodResult<M>, Error> {
    return useQuery({
        queryKey: caxriQueryKey(method, params),
        queryFn: () => caxri.request(method, ...([params] as ParamsArg<M>)),
        ...options,
    });
}

/**
 * Renders one error toast per distinct query failure, replacing the `.catch(error => pushToast(...))`
 * every read used to write inline. Keyed off `error` identity, so a `refetch()` that resolves clears
 * the effect's dependency and a new failure — not a re-render of the same one — is what re-fires it.
 */
export function useToastOnQueryError(isError: boolean, error: Error | null, label: string): void {
    useEffect(() => {
        if (isError) pushToast('error', describeFailure(error, label));
    }, [isError, error, label]);
}

/** Debounce window used to coalesce a burst of `files.changed` events into one invalidation pass. */
const FILE_CHANGE_INVALIDATION_DEBOUNCE_MS = 150;

/**
 * Invalidates the Session-scoped read queries that a `files.changed` event cheaply reflects: Git
 * status and diffs. `files.list` is deliberately excluded — {@link FileTreePanel} tracks which
 * directories a change actually touched and invalidates only those, which this session-wide pass
 * would otherwise blur. `projectStatus.summary`/`projectStatus.overview` are excluded too: unlike
 * `git.summary`, a Project Status read may shell out to a delivery CLI (e.g. `gh`), so it stays on
 * its own polling interval instead of re-running on every file write.
 */
function invalidateFileDependentQueries(
    queryClient: ReturnType<typeof useQueryClient>,
    sessionId: string,
): void {
    const sessionScoped = new Set<CaxriMethod>(['git.summary', 'git.diff', 'git.diffDocument']);
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, params] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return sessionScoped.has(method) && params?.sessionId === sessionId;
        },
    });
}

/**
 * Wires `caxri.onEvent` runtime pushes to targeted query invalidation. Mounted once at the app root
 * (see `App.tsx`) alongside the existing Zustand `subscribeWorkbenchEvents` wiring — Session/Project
 * bootstrap state stays on that push-based Zustand path; this hook only owns the request/response
 * reads that moved to React Query.
 */
export function useRuntimeQueryInvalidation(): void {
    const queryClient = useQueryClient();
    useEffect(() => {
        const pendingTimers = new Map<string, number>();
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event !== 'files.changed') return;
            const { sessionId } = event.payload;
            const existing = pendingTimers.get(sessionId);
            if (existing !== undefined) window.clearTimeout(existing);
            pendingTimers.set(
                sessionId,
                window.setTimeout(() => {
                    pendingTimers.delete(sessionId);
                    invalidateFileDependentQueries(queryClient, sessionId);
                }, FILE_CHANGE_INVALIDATION_DEBOUNCE_MS),
            );
        });
        return () => {
            unsubscribe();
            for (const timer of pendingTimers.values()) window.clearTimeout(timer);
        };
    }, [queryClient]);
}

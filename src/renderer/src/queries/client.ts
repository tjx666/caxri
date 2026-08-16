import { useEffect } from 'react';

import type { CaxriMethod, MethodResult, ParamsArg } from '@shared/ipc';
import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import { QueryClient, useQuery } from '@tanstack/react-query';

import { caxri } from '../lib/caxri';
import { describeFailure, pushToast } from '../stores/toasts';

/**
 * Module-scoped singleton so non-component code (e.g. `features/session/session-actions.ts`) can reach the same cache
 * `QueryClientProvider` renders with in `main.tsx`, instead of only being reachable through the `useQueryClient` hook
 * inside a component.
 *
 * Server-state defaults tuned for a local-IPC app rather than a network API: there is no other client to race with over
 * `window.caxri`, so a background window-focus refetch only doubles Runtime work, and an IPC rejection is a real
 * failure (a bad path, a closed Session) rather than a transient network blip worth retrying. Individual queries
 * override `staleTime` where a shorter or longer window makes sense (see the `useCaxriQuery` call sites below).
 */
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            refetchOnWindowFocus: false,
            retry: 0,
            staleTime: 10_000,
        },
        mutations: {
            retry: 0,
        },
    },
});

/**
 * The single params argument a Caxri method accepts, or `undefined` for a no-params method.
 */
type MethodParameters<M extends CaxriMethod> = ParamsArg<M>[0];

/**
 * Cache key for a Caxri read: the method name paired with its params, so distinct params (a different Session, a
 * different file path) never collide in the query cache. This is the "keyed by method name + params" factory the
 * server-state layer is built on — every read and every targeted invalidation goes through it instead of an ad hoc
 * string.
 */
export type CaxriQueryKey<M extends CaxriMethod> = readonly [M, MethodParameters<M>];

export function caxriQueryKey<M extends CaxriMethod>(
    method: M,
    parameters: MethodParameters<M>,
): CaxriQueryKey<M> {
    return [method, parameters] as CaxriQueryKey<M>;
}

/**
 * Typed `useQuery` over a Caxri RPC method. Full inference flows from the method table in `@shared/ipc`: `params` must
 * match the method's schema and the resolved data is `MethodResult<M>`, with no `any` at any point. Callers gate an
 * unavailable dependency (no Session selected, for instance) with `enabled: false` rather than skipping the hook — the
 * params value itself may be a placeholder in that case, since a disabled query never runs `queryFn`.
 */
export function useCaxriQuery<M extends CaxriMethod>(
    method: M,
    parameters: MethodParameters<M>,
    options?: Omit<
        UseQueryOptions<MethodResult<M>, Error, MethodResult<M>, CaxriQueryKey<M>>,
        'queryKey' | 'queryFn'
    >,
): UseQueryResult<MethodResult<M>, Error> {
    return useQuery({
        queryKey: caxriQueryKey(method, parameters),
        queryFn: () => caxri.request(method, ...([parameters] as ParamsArg<M>)),
        ...options,
    });
}

/**
 * Renders one error toast per distinct query failure, replacing the `.catch(error => pushToast(...))` every read used
 * to write inline. Keyed off `error` identity, so a `refetch()` that resolves clears the effect's dependency and a new
 * failure — not a re-render of the same one — is what re-fires it.
 */
export function useToastOnQueryError(isError: boolean, error: Error | null, label: string): void {
    useEffect(() => {
        if (isError) pushToast('error', describeFailure(error, label));
    }, [isError, error, label]);
}

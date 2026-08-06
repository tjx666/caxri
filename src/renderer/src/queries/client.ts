import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { CaxriMethod, MethodResult, ParamsArg } from '@shared/ipc';

import { caxri } from '../lib/caxri';
import { describeFailure, pushToast } from '../stores/toasts';

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

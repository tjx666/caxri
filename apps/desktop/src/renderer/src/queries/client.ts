import { useEffect } from 'react';

import type { CaxriMethod, MethodResult, ParametersArgument } from '@caxri/protocol';
import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import { QueryClient, QueryObserver, useQuery } from '@tanstack/react-query';

import { caxri } from '../lib/caxri';
import { describeFailure, isCancelledRequest, pushToast } from '../stores/toasts';

/**
 * Extension Tree branches outlive React Query's five-minute default because the view that reads them is remounted by
 * Session identity: returning to a Session is a minutes-scale action, so the default window would drop the tree exactly
 * when the user expects to find it still there. The payload is bounded by the protocol's tree-item ceiling, and an
 * unobserved branch is still swept when its Session is deleted (see `removeSessionQueries`).
 */
export const EXTENSION_TREE_GC_TIME_MS = 30 * 60_000;

/**
 * The two query-key namespaces more than one module has to agree on, owned here because the data layer owns key shapes.
 *
 * A cache predicate that spells the method out as a bare string never fails loudly: rename the method or reshape the
 * key and the comparison simply stops matching anything, which is how two `viewContainers.treeChildren` predicates
 * survived unnoticed after the shape they matched was gone (issue #799). `satisfies CaxriMethod` makes a typo or a
 * removed method a type error, and sharing one constant between the key factory and every matcher makes the two move
 * together.
 */
export const CONTROLLED_VIEW_QUERY_METHOD = 'viewContainers.viewOperation' satisfies CaxriMethod;
export const EXTENSION_TREE_CHILDREN_QUERY_METHOD =
    'viewContainers.treeChildren' satisfies CaxriMethod;

/**
 * Server-state defaults tuned for a local-IPC app rather than a network API: there is no other client to race with over
 * `window.caxri`, so a background window-focus refetch only doubles Server work, and an IPC rejection is a real failure
 * (a bad path, a closed Session) rather than a transient network blip worth retrying. Individual queries override
 * `staleTime` where a shorter or longer window makes sense (see the `useCaxriQuery` call sites below).
 */
export function createCaxriQueryClient(): QueryClient {
    const client = new QueryClient({
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
    client.setQueryDefaults([EXTENSION_TREE_CHILDREN_QUERY_METHOD], {
        gcTime: EXTENSION_TREE_GC_TIME_MS,
    });
    return client;
}

/**
 * Module-scoped singleton so non-component code (e.g. `features/session/session-commands.ts`) can reach the same cache
 * `QueryClientProvider` renders with in `main.tsx`, instead of only being reachable through the `useQueryClient` hook
 * inside a component.
 */
export const queryClient = createCaxriQueryClient();

/**
 * The single params argument a Caxri method accepts, or `undefined` for a no-params method.
 */
type MethodParameters<M extends CaxriMethod> = ParametersArgument<M>[0];

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
 * The matching half of {@link caxriQueryKey}, for the invalidation predicates in `invalidation.ts`.
 *
 * React Query hands a predicate a `readonly unknown[]`, so comparing `queryKey[0]` to a bare string literal is not
 * typechecked: renaming a method leaves the predicate matching nothing, silently and permanently. Two
 * `viewContainers.treeChildren` predicates were dead that way from the day they were written. Taking the names as
 * `CaxriMethod` arguments makes a typo or a stale name a compile error at the call site.
 */
export function isQueryMethod(
    queryKey: readonly unknown[],
    ...methods: readonly [CaxriMethod, ...CaxriMethod[]]
): boolean {
    const method = queryKey[0];
    return typeof method === 'string' && (methods as readonly string[]).includes(method);
}

/**
 * Typed `useQuery` over a Caxri RPC method. Full inference flows from the method table in `@caxri/protocol`: `params`
 * must match the method's schema and the resolved data is `MethodResult<M>`, with no `any` at any point. Callers gate
 * an unavailable dependency (no Session selected, for instance) with `enabled: false` rather than skipping the hook —
 * the params value itself may be a placeholder in that case, since a disabled query never runs `queryFn`.
 *
 * `TData` is inferred from `select` when one is passed, so a caller can subscribe to a projection of the result instead
 * of the whole thing. That is a subscription narrowing, not a formatting convenience: TanStack applies structural
 * sharing to the projected value, so a caller re-renders only when its own slice actually changed.
 */
export function useCaxriQuery<M extends CaxriMethod, TData = MethodResult<M>>(
    method: M,
    parameters: MethodParameters<M>,
    options?: Omit<
        UseQueryOptions<MethodResult<M>, Error, TData, CaxriQueryKey<M>>,
        'queryKey' | 'queryFn'
    >,
): UseQueryResult<TData, Error> {
    return useQuery({
        queryKey: caxriQueryKey(method, parameters),
        queryFn: () => caxri.request(method, ...([parameters] as ParametersArgument<M>)),
        ...options,
    });
}

/**
 * One-shot read through the shared cache, for a builder that runs at the moment it needs the data (a native context
 * menu opening) instead of subscribing on every render. Shares `useCaxriQuery`'s key, so a fresh cached answer is
 * reused and targeted invalidation reaches it. Pass `staleTime: 0` when the caller already knows the cached answer is
 * out of date, such as right after a Server event said it changed.
 */
export function fetchCaxriQuery<M extends CaxriMethod>(
    method: M,
    parameters: MethodParameters<M>,
    options?: { staleTime?: number },
): Promise<MethodResult<M>> {
    return queryClient.query({
        queryKey: caxriQueryKey(method, parameters),
        queryFn: () => caxri.request(method, ...([parameters] as ParametersArgument<M>)),
        ...options,
    });
}

/**
 * Subscribes to a Caxri read from outside a component — an imperative Monaco integration cannot call a hook — through
 * the same `QueryObserver` `useCaxriQuery` builds on, so the two never disagree about cache key shape, staleness, or
 * targeted invalidation. Calls `listener` once synchronously with whatever is already cached (frequently already
 * populated by a sibling `useCaxriQuery` reader) and again on every subsequent fetch or invalidation.
 */
export function subscribeCaxriQuery<M extends CaxriMethod>(
    method: M,
    parameters: MethodParameters<M>,
    listener: (data: MethodResult<M> | undefined) => void,
): () => void {
    const observer = new QueryObserver(queryClient, {
        queryKey: caxriQueryKey(method, parameters),
        queryFn: () => caxri.request(method, ...([parameters] as ParametersArgument<M>)),
    });
    listener(observer.getCurrentResult().data);
    return observer.subscribe((result) => listener(result.data));
}

/**
 * Renders one error toast per distinct query failure, replacing the `.catch(error => pushToast(...))` every read used
 * to write inline. Keyed off `error` identity, so a `refetch()` that resolves clears the effect's dependency and a new
 * failure — not a re-render of the same one — is what re-fires it.
 */
export function useToastOnQueryError(isError: boolean, error: Error | null, label: string): void {
    useEffect(() => {
        if (shouldToastQueryError(isError, error))
            pushToast('error', describeFailure(error, label));
    }, [isError, error, label]);
}

/**
 * Scope retirement is expected while switching Sessions or Workbench Roots. The stale query is already replaced by the
 * new controlled-view scope, so surfacing its typed cancellation as a persistent error would be a false failure.
 */
export function shouldToastQueryError(isError: boolean, error: Error | null): boolean {
    return isError && !isCancelledRequest(error);
}

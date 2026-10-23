import { useEffect, useState } from 'react';

import type { CaxriMethod, MethodResult, ParametersArgument } from '@caxri/protocol';
import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';

import {
    isDocumentVisible,
    registerPoll,
    resolvePollIntervalMs,
    subscribeVisibility,
    unregisterPoll,
} from '../lib/poll-scheduler';
import { useCaxriQuery } from '../queries/client';
import { useOnVisible } from './use-on-visible';

/**
 * The single params argument a Caxri method accepts, or `undefined` for a no-params method. Mirrors the same helper
 * type in `queries/client.ts`, kept local because that module does not export it.
 */
type MethodParameters<M extends CaxriMethod> = ParametersArgument<M>[0];

export interface UsePolledQueryOptions<M extends CaxriMethod> extends Omit<
    UseQueryOptions<MethodResult<M>, Error, MethodResult<M>, readonly [M, MethodParameters<M>]>,
    'queryKey' | 'queryFn' | 'refetchInterval'
> {
    /**
     * Reason label registered in the shared poll registry (see `lib/poll-scheduler.ts`); shown in `getActivePolls()`.
     */
    label: string;
    /**
     * Poll cadence while the document is visible. Ignored (no interval) while the document is hidden.
     */
    intervalMs: number;
}

/**
 * Thin wrapper over {@link useCaxriQuery} that pauses its `refetchInterval` while the document is hidden and refetches
 * once immediately when the document becomes visible again, instead of polling a backgrounded window on the same
 * cadence as a foreground one. Registers/unregisters the poll in the shared registry (`lib/poll-scheduler.ts`) for the
 * lifetime of the hook so `getActivePolls()` reflects every currently active query poll.
 *
 * Call sites otherwise use this exactly like `useCaxriQuery`, plus the required `label`/`intervalMs` pair.
 */
export function usePolledQuery<M extends CaxriMethod>(
    method: M,
    parameters: MethodParameters<M>,
    options: UsePolledQueryOptions<M>,
): UseQueryResult<MethodResult<M>, Error> {
    const { label, intervalMs: configuredIntervalMs, enabled = true, ...rest } = options;
    const intervalMs = resolvePollIntervalMs(configuredIntervalMs);
    const [isVisible, setIsVisible] = useState(isDocumentVisible);

    useEffect(() => subscribeVisibility(setIsVisible), []);

    useEffect(() => {
        if (!enabled) return;
        const id = registerPoll(label, intervalMs);
        return () => unregisterPoll(id);
    }, [enabled, label, intervalMs]);

    const query = useCaxriQuery(method, parameters, {
        ...rest,
        enabled,
        refetchInterval: enabled && isVisible ? intervalMs : false,
    });

    // Fires only on the actual `focus`/`visibilitychange` event, never on mount, so this never duplicates the query's
    // own initial fetch: see `useOnVisible`'s contract.
    useOnVisible(() => {
        // Fire-and-forget: `useCaxriQuery`/`useToastOnQueryError` already own reporting a failed refetch (see call
        // sites), so this resume-triggered refresh has nothing further to await.
        // Showing a window fires both `visibilitychange` and `focus`; `cancelRefetch: false` lets the second join the
        // first read instead of cancelling and reissuing it.
        if (enabled) void query.refetch({ cancelRefetch: false });
    });

    return query;
}

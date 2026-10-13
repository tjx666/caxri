import { useEffect, useState } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, useCaxriQuery } from '../../queries/client';
import { refreshBenchmarkCatalog } from './benchmark-commands';

/**
 * A run in progress is re-read this often in case a `benchmark.changed` event was lost to a reconnect; events keep it
 * current between reads.
 */
const RUNNING_REFETCH_MS = 5_000;

/**
 * Keeps the Benchmark reads current: every `benchmark.changed` refreshes the history and the run it names. The event is
 * transient and content-free, so a reader always re-reads instead of patching.
 */
export function useBenchmarkEvents(): void {
    const queryClient = useQueryClient();
    useEffect(
        () =>
            caxri.onEvent((event) => {
                if (event.event !== 'benchmark.changed') return;
                // eslint-disable-next-line no-void -- React Query owns invalidation errors
                void queryClient.invalidateQueries({
                    queryKey: caxriQueryKey('benchmark.list', {}),
                });
                // eslint-disable-next-line no-void -- React Query owns invalidation errors
                void queryClient.invalidateQueries({
                    queryKey: caxriQueryKey('benchmark.get', { runId: event.payload.runId }),
                });
            }),
        [queryClient],
    );
}

export function useBenchmarkRuns() {
    return useCaxriQuery('benchmark.list', {});
}

export function useBenchmarkRun(runId: string | undefined) {
    return useCaxriQuery(
        'benchmark.get',
        { runId: runId ?? '' },
        {
            enabled: runId !== undefined,
            refetchInterval: (query) =>
                query.state.data?.status === 'running' ? RUNNING_REFETCH_MS : false,
        },
    );
}

/**
 * The models each Agent offers. The Server probes each installed Agent once and caches the answer, so this read stays
 * fresh for the page's lifetime; `refresh` probes again after the user signs in or installs an Agent.
 */
export function useBenchmarkCatalog() {
    const query = useCaxriQuery('benchmark.catalog', {}, { staleTime: Infinity });
    const [isRefreshing, setIsRefreshing] = useState(false);
    const refresh = async () => {
        setIsRefreshing(true);
        try {
            await refreshBenchmarkCatalog();
        } finally {
            setIsRefreshing(false);
        }
    };
    return { ...query, isRefreshing, refresh };
}

/**
 * The current time, advancing every second while `isActive`, for elapsed times of runs still in progress.
 */
export function useTickingNow(isActive: boolean): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!isActive) return;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [isActive]);
    return now;
}

import type { BenchmarkCatalog, BenchmarkStartParameters } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';

/**
 * Starts a run and returns its id. The history list is refreshed here because the new run is selected before its first
 * `benchmark.changed` event arrives.
 */
export async function startBenchmark(parameters: BenchmarkStartParameters): Promise<string> {
    const { runId } = await caxri.request('benchmark.start', parameters);
    void queryClient.invalidateQueries({ queryKey: caxriQueryKey('benchmark.list', {}) });
    return runId;
}

/**
 * Cancels a whole run, or only one of its Attempts when `attemptId` is given.
 */
export async function cancelBenchmark(runId: string, attemptId?: string): Promise<void> {
    await caxri.request(
        'benchmark.cancel',
        attemptId === undefined ? { runId } : { runId, attemptId },
    );
}

export async function deleteBenchmark(runId: string): Promise<void> {
    await caxri.request('benchmark.delete', { runId });
    queryClient.removeQueries({ queryKey: caxriQueryKey('benchmark.get', { runId }) });
}

/**
 * Probes every Agent again, for after the user signs in or installs one, and replaces the cached catalog.
 */
export async function refreshBenchmarkCatalog(): Promise<void> {
    const catalog: BenchmarkCatalog = await caxri.request('benchmark.catalog', { refresh: true });
    queryClient.setQueryData(caxriQueryKey('benchmark.catalog', {}), catalog);
}

import type { DomainHandlers } from '../domain-services';
import type { BenchmarkService } from './service';

export function createBenchmarkHandlers(
    benchmark: BenchmarkService,
): Pick<
    DomainHandlers,
    | 'benchmark.attemptDiff'
    | 'benchmark.cancel'
    | 'benchmark.catalog'
    | 'benchmark.delete'
    | 'benchmark.get'
    | 'benchmark.list'
    | 'benchmark.start'
> {
    return {
        'benchmark.catalog': ({ refresh: shouldRefresh }) => benchmark.catalog(shouldRefresh),
        'benchmark.list': () => benchmark.list(),
        'benchmark.get': ({ runId }) => benchmark.get(runId),
        'benchmark.attemptDiff': ({ runId, attemptId }) => benchmark.attemptDiff(runId, attemptId),
        'benchmark.start': (parameters) => benchmark.start(parameters),
        'benchmark.cancel': ({ runId, attemptId }) => benchmark.cancel(runId, attemptId),
        'benchmark.delete': ({ runId }) => benchmark.delete(runId),
    };
}

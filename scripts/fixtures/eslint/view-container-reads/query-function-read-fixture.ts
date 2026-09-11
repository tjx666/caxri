import { caxri } from './fixture-caxri';

/**
 * Compliant fixture: the read is issued from a `queryFn`, so React Query owns its key, lifetime, and invalidation.
 */
export function catalogQueryOptions() {
    return {
        queryKey: ['viewContainers.catalog', {}],
        queryFn: () => caxri.request('viewContainers.catalog', {}),
    };
}

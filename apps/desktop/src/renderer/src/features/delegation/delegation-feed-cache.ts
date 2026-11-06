import type { MethodResult } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { isQueryMethod, queryClient } from '../../queries/client';
import { humanControlledSessionIds } from './delegation-feed';

/**
 * The taken-over delegated Sessions (`humanControlledSessionIds`) across every Delegated Sessions feed read in the
 * cache, for commands that order Sessions outside React (previous/next Session, selecting a Project). The Project tree
 * keeps these reads mounted, so the answer matches the rows on screen.
 */
export function cachedHumanControlledSessionIds(
    client: QueryClient = queryClient,
): ReadonlySet<string> {
    const cached = client.getQueriesData<MethodResult<'agent.delegation.sessions'>>({
        predicate: ({ queryKey }) => isQueryMethod(queryKey, 'agent.delegation.sessions'),
    });
    return new Set(humanControlledSessionIds(cached.flatMap(([, data]) => data?.sessions ?? [])));
}

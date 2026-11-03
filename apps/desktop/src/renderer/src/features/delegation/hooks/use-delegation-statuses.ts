import { useMemo } from 'react';

import type { AgentDelegationStatusEntry, MethodResult } from '@caxri/protocol';
import type { UseQueryResult } from '@tanstack/react-query';
import { keepPreviousData, useQueries } from '@tanstack/react-query';

import { caxri } from '../../../lib/caxri';
import { caxriQueryKey } from '../../../queries/client';
import { delegationStatusIdChunks } from '../delegation-statuses';

/**
 * Like the feed, the reads have no poll: a Session's record push refreshes the ones that name a task in it (see
 * `invalidation-delegation-feed.ts`), and this window is the backstop for a push the window could not hear.
 */
const DELEGATION_STATUSES_STALE_TIME_MS = 60_000;

const NO_STATUSES: AgentDelegationStatusEntry[] = [];

/**
 * Module scope on purpose, for the same reason as `combineDelegationFeeds`.
 */
function combineDelegationStatuses(
    results: ReadonlyArray<UseQueryResult<MethodResult<'agent.delegation.statuses'>, Error>>,
): AgentDelegationStatusEntry[] {
    const statuses = results.flatMap((result) => result.data?.statuses ?? NO_STATUSES);
    return statuses.length === 0 ? NO_STATUSES : statuses;
}

export interface DelegationStatusesOptions {
    /**
     * False asks nothing; see `DelegationFeedOptions.isEnabled`. Defaults to true.
     */
    isEnabled?: boolean;
}

/**
 * The state of each named task, by task ID, for the records a Chat timeline draws (`agent.delegation.statuses`). A task
 * the Server no longer has is absent from the map, and a record then shows no state. Read one set per Chat rather than
 * one per record: the IDs are chunked to the most one read accepts, and a record looks its task up in the map.
 */
export function useDelegationStatuses(
    delegationIds: readonly string[],
    { isEnabled = true }: DelegationStatusesOptions = {},
): ReadonlyMap<string, AgentDelegationStatusEntry> {
    const statuses = useQueries({
        combine: combineDelegationStatuses,
        queries: delegationStatusIdChunks(delegationIds).map((ids) => ({
            enabled: isEnabled,
            placeholderData: keepPreviousData,
            queryFn: () => caxri.request('agent.delegation.statuses', { delegationIds: ids }),
            queryKey: caxriQueryKey('agent.delegation.statuses', { delegationIds: ids }),
            staleTime: DELEGATION_STATUSES_STALE_TIME_MS,
        })),
    });
    return useMemo(
        () => new Map(statuses.map((status) => [status.delegationId, status])),
        [statuses],
    );
}

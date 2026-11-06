import { useMemo } from 'react';

import { useCaxriQuery } from '../../../queries/client';
import { mergedPullRequestSessionIds } from '../../primary-sidebar/session-pull-request';
import { SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS } from '../../session/session-commands';

const NO_SESSION_IDS: string[] = [];

/**
 * Sessions whose pull request merged, read from the snapshot `useSessionPullRequestPoll` keeps fresh (same query key,
 * so this adds an observer rather than a request). Activity ranks a merged task above a plain result in Needs
 * attention.
 *
 * `select` narrows the subscription to the merged ids, which React Query keeps referentially stable while they do not
 * change, so a poll that moved some other pull request leaves the Activity groups alone.
 */
export function useMergedPullRequestSessionIds(): ReadonlySet<string> {
    const ids =
        useCaxriQuery('session.pullRequests', undefined, {
            refetchOnMount: false,
            select: mergedPullRequestSessionIds,
            staleTime: SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS,
        }).data ?? NO_SESSION_IDS;
    return useMemo(() => new Set(ids), [ids]);
}

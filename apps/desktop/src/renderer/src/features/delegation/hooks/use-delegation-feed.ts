import { useMemo } from 'react';

import type { AgentDelegationSession, MethodResult } from '@caxri/protocol';
import type { UseQueryResult } from '@tanstack/react-query';
import { keepPreviousData, useQueries } from '@tanstack/react-query';

import { caxri } from '../../../lib/caxri';
import { caxriQueryKey } from '../../../queries/client';
import { failedDelegationSessionIds, userPendingSessionIds } from '../delegation-feed';

/**
 * The feed has no poll: `subscribeRuntimeQueryInvalidation` refreshes it when a delegated Session's state changes (see
 * `invalidation-delegation-feed.ts`). A finite window is still the backstop for a change that arrived while the window
 * could not hear it (a reconnect), picked up the next time a row mounts.
 */
const DELEGATION_FEED_STALE_TIME_MS = 60_000;

const NO_ENTRIES: AgentDelegationSession[] = [];

/**
 * Module scope on purpose: `useQueries` memoizes the combined value by the identity of this function, and an inline
 * arrow would rebuild it on every render of the whole sidebar.
 *
 * A chunk whose read failed contributes nothing, so a failed read shows no failure until the next read succeeds; the
 * status slot is a hint, never worth an error toast. A creating Session with more than `MAX_DELEGATION_SESSIONS`
 * Sessions has its oldest ones missing from the read, which only costs those the failure glyph.
 */
function combineDelegationFeeds(
    results: ReadonlyArray<UseQueryResult<MethodResult<'agent.delegation.sessions'>, Error>>,
): AgentDelegationSession[] {
    const entries = results.flatMap((result) => result.data?.sessions ?? NO_ENTRIES);
    return entries.length === 0 ? NO_ENTRIES : entries;
}

export interface DelegationFeed {
    /**
     * The nested Sessions whose permission request or question waits on the user (it was not covered, or its grace
     * ended): an escalated question keeps the cue too (`isDelegationUserPending`). Feeds `sessionStatus`'s
     * `approvalPending` option, which keeps the amber cue until the request is decided or the question answered.
     */
    approvalSessionIds: ReadonlySet<string>;
    /**
     * Every entry the reads returned, in the order the Server listed them (newest Session first within one creator).
     */
    entries: readonly AgentDelegationSession[];
    /**
     * Each nested Session's delegation state, keyed by Session id, for the detail the row shows beyond its status.
     */
    entriesBySessionId: ReadonlyMap<string, AgentDelegationSession>;
    /**
     * The nested Sessions whose newest delegation failed. Feeds `sessionStatus`'s `delegationFailed` option.
     */
    failedSessionIds: ReadonlySet<string>;
}

export interface DelegationFeedOptions {
    /**
     * False asks nothing: a window that cannot show another Session (the Caxri Bot and Benchmark windows, whose
     * policies refuse the read) never issues the query. Defaults to true.
     */
    isEnabled?: boolean;
}

/**
 * Reads the Delegated Sessions feed (`agent.delegation.sessions`) for the given creator-id chunks
 * (`delegationFeedCreatorIdChunks`), which is the only place a Session's delegation state reaches the Renderer: a
 * Session record cannot tell that its task failed. Returns the previous answer while the creator set changes, so a
 * failed row does not flash back to its settled state each time a new delegation starts.
 *
 * Shared by the Project tree's nested rows (chunks of every creator in view) and a Chat's Delegated Sessions strip (one
 * chunk holding the Chat's own Session), which read the same cache entries when they ask the same question.
 */
export function useDelegationFeed(
    creatorIdChunks: ReadonlyArray<readonly string[]>,
    { isEnabled = true }: DelegationFeedOptions = {},
): DelegationFeed {
    const entries = useQueries({
        combine: combineDelegationFeeds,
        queries: creatorIdChunks.map((createdBySessionIds) => ({
            enabled: isEnabled,
            placeholderData: keepPreviousData,
            queryFn: () =>
                caxri.request('agent.delegation.sessions', {
                    createdBySessionIds: [...createdBySessionIds],
                }),
            queryKey: caxriQueryKey('agent.delegation.sessions', {
                createdBySessionIds: [...createdBySessionIds],
            }),
            staleTime: DELEGATION_FEED_STALE_TIME_MS,
        })),
    });
    return useMemo(
        () => ({
            approvalSessionIds: new Set(userPendingSessionIds(entries)),
            entries,
            entriesBySessionId: new Map(entries.map((entry) => [entry.sessionId, entry])),
            failedSessionIds: new Set(failedDelegationSessionIds(entries)),
        }),
        [entries],
    );
}

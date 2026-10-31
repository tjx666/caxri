import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { MobilePullRequest } from '@caxri/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useTranslation } from '../../i18n';
import { useMobileClient } from '../connection/mobile-client-provider';
import {
    dismissFailedMerge,
    overlayMerge,
    pullRequestMergeKey,
    pullRequestMergeStore,
    settleCheckedMerge,
} from './pull-request-merge-store';
import {
    isPullRequestMergeTransportError,
    pullRequestMergeErrorMessage,
} from './pull-request-model';

/**
 * How often the chip re-reads while the sheet is closed: often enough that a check finishing or a merge on Desktop
 * shows up during a glance, rarely enough that an idle phone does not keep GitHub busy.
 */
const IDLE_REFRESH_MS = 120_000;

/**
 * How often an open sheet re-reads while the answer is still settling (checks running, mergeability unknown), so the
 * user watching it sees the merge button turn ready without pulling to refresh.
 */
const WATCHING_REFRESH_MS = 15_000;

/**
 * After a merge request died in transport, how many fresh reads (and how far apart) must still show the pull request
 * open before it counts as not merged: the Server finishes `gh pr merge` on its own, typically within seconds.
 */
const CHECK_ATTEMPTS = 6;
const CHECK_INTERVAL_MS = 4_000;

const isSettling = (pullRequest: MobilePullRequest | undefined): boolean =>
    pullRequest?.lifecycle === 'open' &&
    (pullRequest.mergeBlocker === 'checks-running' ||
        pullRequest.mergeBlocker === 'mergeability-unknown' ||
        !pullRequest.headSha);

/**
 * The cache key of a Session's pull request read. A Status panel `Merge` re-reads it too, so the header chip turns
 * merged at once instead of after the idle poll.
 */
export const sessionPullRequestQueryKey = (connectionScopeKey: string | null, sessionId: string) =>
    ['mobile', 'pull-request', connectionScopeKey ?? 'unpaired', sessionId] as const;

/**
 * The Session's pull request from Desktop's Project Status, and the merge a control device can start. Nothing pushes
 * pull request changes to the phone, so the read polls: slowly for the header chip, faster while the open sheet waits
 * for checks to settle. A merge refreshes the read so every surface shows the merged state.
 */
export const useSessionPullRequest = (sessionId: string, isWatching: boolean) => {
    const { t } = useTranslation();
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const queryClient = useQueryClient();
    const queryKey = useMemo(
        () => sessionPullRequestQueryKey(connectionScopeKey, sessionId),
        [connectionScopeKey, sessionId],
    );
    const isObservable = connectionScopeKey !== null && isForeground && status === 'connected';
    const mergeKey = pullRequestMergeKey(connectionScopeKey, sessionId);
    const merge = useSyncExternalStore(pullRequestMergeStore.subscribe, () =>
        pullRequestMergeStore.get(mergeKey),
    );
    const isChecking = merge.state === 'checking';
    const query = useQuery({
        enabled: isObservable,
        gcTime: 5 * 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.pullRequest.read', { sessionId }),
        queryKey,
        // A merge whose answer was lost re-reads quickly until it settles; see the effect below.
        refetchInterval: (current) =>
            isChecking
                ? CHECK_INTERVAL_MS
                : isWatching && isSettling(current.state.data?.pullRequest)
                  ? WATCHING_REFRESH_MS
                  : IDLE_REFRESH_MS,
        refetchIntervalInBackground: false,
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 10_000,
    });
    const { refetch } = query;
    /**
     * Opening the sheet re-reads at once: a pull request marked ready (or merged) on GitHub while the sheet was closed
     * must not wait out the idle poll. Returning to the app needs no call: the query is disabled in the background, and
     * re-enabling it refetches once the 10 second stale window has passed.
     */
    const refresh = useCallback(() => {
        if (isObservable) void refetch();
    }, [isObservable, refetch]);
    const startMerge = useCallback(
        async (pullRequest: MobilePullRequest): Promise<void> => {
            if (!pullRequest.headSha) return;
            pullRequestMergeStore.set(mergeKey, { state: 'merging', number: pullRequest.number });
            try {
                const { method } = await request('mobile.pullRequest.merge', {
                    sessionId,
                    repositoryId: pullRequest.repositoryId,
                    number: pullRequest.number,
                    headSha: pullRequest.headSha,
                });
                pullRequestMergeStore.set(mergeKey, {
                    state: 'merged',
                    message: t(`pullRequest.merged.${method}`, { number: pullRequest.number }),
                    number: pullRequest.number,
                });
            } catch (error) {
                // A transport failure leaves the outcome unknown (the Server keeps merging after the phone drops), so
                // the effect below re-reads the pull request once connected instead of reporting a failure.
                pullRequestMergeStore.set(
                    mergeKey,
                    isPullRequestMergeTransportError(error)
                        ? {
                              state: 'checking',
                              number: pullRequest.number,
                              lastReadAt: Date.now(),
                              reads: 0,
                          }
                        : { state: 'failed', message: pullRequestMergeErrorMessage(error, t) },
                );
            }
            // A failed merge can mean the pull request changed under the sheet; either way show what is true now.
            await queryClient.invalidateQueries({ queryKey, exact: true });
        },
        [mergeKey, queryClient, queryKey, request, sessionId, t],
    );
    const { data, dataUpdatedAt } = query;
    /**
     * A merge whose request died in transport has no answer yet. The query re-reads every few seconds while it is
     * `checking` (once connected again: a disconnected phone does not read), and each successful read settles it, so
     * the sheet never stays on `Checking the pull request` and the chip never keeps a stale hint. A failed read is not
     * an answer, and only a read taken after the failure counts.
     */
    useEffect(() => {
        if (!isChecking || dataUpdatedAt === 0) return;
        pullRequestMergeStore.update(mergeKey, (current) =>
            settleCheckedMerge(
                current,
                { pullRequest: data?.pullRequest, readAt: dataUpdatedAt },
                CHECK_ATTEMPTS,
                {
                    merged: (number) => t('pullRequest.mergedConfirmed', { number }),
                    notCompleted: t('pullRequest.mergeNotCompleted'),
                },
            ),
        );
    }, [data, dataUpdatedAt, isChecking, mergeKey, t]);
    /**
     * Closing the sheet drops a failed attempt, so reopening it after fixing the blocker does not repeat the old error.
     */
    const dismissMergeFailure = useCallback(
        () => pullRequestMergeStore.update(mergeKey, dismissFailedMerge),
        [mergeKey],
    );
    const pullRequest = overlayMerge(query.data?.pullRequest, merge);
    return {
        isObservable,
        merge,
        pullRequest,
        dismissMergeFailure,
        refresh,
        startMerge,
    };
};

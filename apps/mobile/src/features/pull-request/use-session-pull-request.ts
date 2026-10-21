import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MobilePullRequest } from '@caxri/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useTranslation } from '../../i18n';
import { useMobileClient } from '../connection/mobile-client-provider';
import { pullRequestMergeErrorMessage } from './pull-request-model';

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

const isSettling = (pullRequest: MobilePullRequest | undefined): boolean =>
    pullRequest?.lifecycle === 'open' &&
    (pullRequest.mergeBlocker === 'checks-running' ||
        pullRequest.mergeBlocker === 'mergeability-unknown' ||
        !pullRequest.headSha);

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
        () => ['mobile', 'pull-request', connectionScopeKey ?? 'unpaired', sessionId] as const,
        [connectionScopeKey, sessionId],
    );
    const isObservable = connectionScopeKey !== null && isForeground && status === 'connected';
    const query = useQuery({
        enabled: isObservable,
        gcTime: 5 * 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.pullRequest.read', { sessionId }),
        queryKey,
        refetchInterval: (current) =>
            isWatching && isSettling(current.state.data?.pullRequest)
                ? WATCHING_REFRESH_MS
                : IDLE_REFRESH_MS,
        refetchIntervalInBackground: false,
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 10_000,
    });
    const { refetch } = query;
    const wasWatching = useRef(isWatching);
    const wasForeground = useRef(isForeground);
    /**
     * Opening the sheet and returning to the app each re-read at once: a pull request marked ready (or merged) on
     * GitHub while the phone was away must not wait out the idle poll or the stale window. Mounting alone does not,
     * since the query's own first read covers it.
     */
    useEffect(() => {
        const isOpened = isWatching && !wasWatching.current;
        const returned = isForeground && !wasForeground.current;
        wasWatching.current = isWatching;
        wasForeground.current = isForeground;
        // eslint-disable-next-line no-void -- The read renders into the query.
        if (isObservable && (isOpened || returned)) void refetch();
    }, [isForeground, isObservable, isWatching, refetch]);
    const [merge, setMerge] = useState<
        | { state: 'idle' }
        | { state: 'merging' }
        | { state: 'merged'; message: string; number: number }
        | { state: 'failed'; message: string }
    >({ state: 'idle' });
    const startMerge = useCallback(
        async (pullRequest: MobilePullRequest): Promise<void> => {
            if (!pullRequest.headSha) return;
            setMerge({ state: 'merging' });
            try {
                const { method } = await request('mobile.pullRequest.merge', {
                    sessionId,
                    repositoryId: pullRequest.repositoryId,
                    number: pullRequest.number,
                    headSha: pullRequest.headSha,
                });
                setMerge({
                    state: 'merged',
                    message: t(`pullRequest.merged.${method}`, { number: pullRequest.number }),
                    number: pullRequest.number,
                });
            } catch (error) {
                // A transport failure leaves the outcome unknown; the message says so and the re-read below settles it.
                setMerge({ state: 'failed', message: pullRequestMergeErrorMessage(error, t) });
            }
            // A failed merge can mean the pull request changed under the sheet; either way show what is true now.
            await queryClient.invalidateQueries({ queryKey, exact: true });
        },
        [queryClient, queryKey, request, sessionId, t],
    );
    /**
     * Closing the sheet drops a failed attempt, so reopening it after fixing the blocker does not repeat the old error.
     * A merge still in flight keeps its state (its outcome must survive the sheet), and a merged one keeps the overlay
     * below until Project Status catches up.
     */
    const dismissMergeFailure = useCallback(
        () => setMerge((current) => (current.state === 'failed' ? { state: 'idle' } : current)),
        [],
    );
    const read = query.data?.pullRequest;
    /**
     * GitHub accepted the merge, but Project Status can still answer from before it for a moment. Show the pull request
     * as merged at once so the sheet and the chip never offer to merge it again.
     */
    const pullRequest =
        read && merge.state === 'merged' && merge.number === read.number
            ? { ...read, lifecycle: 'merged' as const, mergeBlocker: undefined }
            : read;
    return {
        isObservable,
        merge,
        pullRequest,
        dismissMergeFailure,
        startMerge,
    };
};

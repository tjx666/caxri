import { useCallback } from 'react';

import type { DelegationRetryMode } from '@caxri/protocol';
import { useMutation } from '@tanstack/react-query';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { isQueryMethod, queryClient, useCaxriQuery } from '../../../queries/client';
import { describeFailure, isCancelledRequest, pushToast } from '../../../stores/toasts';

/**
 * The options are cheap to read but go stale the moment anything else touches the Session, so a short window covers
 * hovering a row and opening its menu without trusting an old answer for long.
 */
const RETRY_OPTIONS_STALE_TIME_MS = 5000;

/**
 * Which retry modes the owner may use for one failed task now (`agent.delegation.retryOptions`). Lazy on purpose: pass
 * `isEnabled` only once the user shows interest (pointer or focus on the action, or its menu open), never per row on
 * mount, because each read makes the Server check the caller, the Session, and the worktree.
 */
export function useDelegationRetryOptions(delegationId: string, isEnabled: boolean) {
    return useCaxriQuery(
        'agent.delegation.retryOptions',
        { delegationId },
        { enabled: isEnabled, staleTime: RETRY_OPTIONS_STALE_TIME_MS },
    );
}

export interface DelegationRetryRequest {
    delegationId: string;
    mode: DelegationRetryMode;
    /**
     * The failed task's Agent, by display name, for the confirmation text.
     */
    providerName: string;
    /**
     * The Project the failed Session lives in, for the fresh-mode confirmation text.
     */
    projectTitle: string;
}

/**
 * Re-reads what the retry changed: the feed (the failed entry gains `retriedAs`, a fresh retry adds a Session), the
 * per-task states behind timeline records, and the options of the retried task. The Server's record push does most of
 * this already; an explicit refresh covers a push this window did not hear.
 */
function refreshAfterRetry(): void {
    void queryClient.invalidateQueries({
        predicate: (query) =>
            isQueryMethod(
                query.queryKey,
                'agent.delegation.sessions',
                'agent.delegation.statuses',
                'agent.delegation.retryOptions',
            ),
    });
}

/**
 * Retries a failed delegated task after the user confirms. Both modes ask first: a resume continues work whose earlier
 * file changes stay, and a fresh start spends quota and may repeat side effects. A refusal or failure reaches the user
 * as one error toast; cancelling starts nothing. `isPending` blocks a second click while the request runs, and the
 * Server shares the run of a repeated request in the same mode anyway.
 */
export function useDelegationRetry(): {
    isPending: boolean;
    retry: (request: DelegationRetryRequest) => Promise<void>;
} {
    const { isPending, mutate } = useMutation({
        mutationFn: (variables: { delegationId: string; mode: DelegationRetryMode }) =>
            caxri.request('agent.delegation.retry', variables),
        onError: (error) => {
            if (!isCancelledRequest(error))
                pushToast(
                    'error',
                    describeFailure(error, translate('delegation.retry.failedLabel'), translate),
                );
        },
        onSettled: refreshAfterRetry,
    });
    const retry = useCallback(
        async ({ delegationId, mode, projectTitle, providerName }: DelegationRetryRequest) => {
            const isFresh = mode === 'fresh';
            const isConfirmed = await caxri.window.showConfirm({
                confirmLabel: translate('delegation.retry.confirm.confirm'),
                message: isFresh
                    ? translate('delegation.retry.confirm.freshMessage', {
                          project: projectTitle,
                      })
                    : translate('delegation.retry.confirm.resumeMessage', {
                          provider: providerName,
                      }),
                title: translate(
                    isFresh
                        ? 'delegation.retry.confirm.freshTitle'
                        : 'delegation.retry.confirm.resumeTitle',
                ),
            });
            if (!isConfirmed) return;
            mutate({ delegationId, mode });
        },
        [mutate],
    );
    return { isPending, retry };
}

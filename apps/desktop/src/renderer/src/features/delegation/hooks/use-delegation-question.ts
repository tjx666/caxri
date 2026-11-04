import { useMutation } from '@tanstack/react-query';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { isQueryMethod, queryClient, useCaxriQuery } from '../../../queries/client';
import { describeFailure, isCancelledRequest, pushToast } from '../../../stores/toasts';

/**
 * The open question's text changes only through `agent.delegation.questionChanged`, which invalidates this read, so a
 * short window just absorbs a remount.
 */
const QUESTION_DETAIL_STALE_TIME_MS = 5000;

/**
 * The open question of one delegated task, with its text (`agent.delegation.questionDetail`, owner-only). Pass
 * `isEnabled` only while the feed says a question is open; the text is private, so nothing asks without that.
 */
export function useDelegationQuestion(delegationId: string | undefined, isEnabled: boolean) {
    return useCaxriQuery(
        'agent.delegation.questionDetail',
        { delegationId: delegationId ?? '' },
        {
            enabled: isEnabled && delegationId !== undefined,
            select: (detail) => detail.question,
            staleTime: QUESTION_DETAIL_STALE_TIME_MS,
        },
    );
}

/**
 * Re-reads what an answer changed: the feed (the row stops asking) and the question's detail. The Server's
 * `questionChanged` push does this too; an explicit refresh covers a push this window did not hear.
 */
function refreshAfterAnswer(): void {
    void queryClient.invalidateQueries({
        predicate: (query) =>
            isQueryMethod(
                query.queryKey,
                'agent.delegation.sessions',
                'agent.delegation.questionDetail',
            ),
    });
}

/**
 * Sends the user's answer (`agent.delegation.questionAnswer`). The first answer wins: the result's `outcome` is
 * `already_answered` or `cancelled` when the question closed first, and the card shows that as an inline note instead
 * of a toast. A refusal or failure reaches the user as one error toast.
 */
export function useDelegationAnswer() {
    return useMutation({
        mutationFn: (variables: { delegationId: string; questionId: string; text: string }) =>
            caxri.request('agent.delegation.questionAnswer', variables),
        onError: (error) => {
            if (!isCancelledRequest(error))
                pushToast(
                    'error',
                    describeFailure(
                        error,
                        translate('delegation.question.sendFailedLabel'),
                        translate,
                    ),
                );
        },
        onSettled: refreshAfterAnswer,
    });
}

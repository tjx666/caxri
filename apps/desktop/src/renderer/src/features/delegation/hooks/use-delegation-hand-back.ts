import { useMutation } from '@tanstack/react-query';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { isQueryMethod, queryClient } from '../../../queries/client';
import { describeFailure, isCancelledRequest, pushToast } from '../../../stores/toasts';
import { handBackRefusalText } from '../delegation-hand-back';

/**
 * Hands a Session the user took over back to the Agent that delegated it (`agent.delegation.handBack`). No
 * confirmation: it sends nothing to the Session and the Agent only gets one follow-up it may or may not use. A refusal
 * reaches the user as one error toast worded from the Server's closed reason; `isPending` blocks a second click while
 * the request runs, and the Server answers a repeated request with the grant that already exists. The feed is re-read
 * afterwards so the row shows the pending state (or the reason it did not).
 */
export function useDelegationHandBack(): {
    handBack: (delegationId: string) => void;
    isPending: boolean;
} {
    const { isPending, mutate } = useMutation({
        mutationFn: (delegationId: string) =>
            caxri.request('agent.delegation.handBack', { delegationId }),
        onError: (error) => {
            if (isCancelledRequest(error)) return;
            const label = translate('delegation.origin.handBackFailed');
            pushToast(
                'error',
                handBackRefusalText(error, translate) ?? describeFailure(error, label, translate),
            );
        },
        onSettled: async () => {
            await queryClient.invalidateQueries({
                predicate: (query) => isQueryMethod(query.queryKey, 'agent.delegation.sessions'),
            });
        },
    });
    return { handBack: mutate, isPending };
}

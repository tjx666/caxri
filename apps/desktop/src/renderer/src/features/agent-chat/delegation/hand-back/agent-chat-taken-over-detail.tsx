import { useTranslation } from '../../../../i18n';
import type { HandBackProperties } from './agent-chat-hand-back-properties';
import { useHandBackView } from './use-hand-back-view';

/**
 * What a taken-over origin row says after "Taken over": that the replies no longer go back, or that a hand-back is
 * waiting for the delegating Agent.
 */
export function AgentChatTakenOverDetail({
    isBusy,
    origin,
    terminalId,
    title,
}: HandBackProperties) {
    const { t } = useTranslation();
    const view = useHandBackView(terminalId, origin, isBusy);
    return t(
        view.kind === 'pending'
            ? 'delegation.origin.handBackPending'
            : 'delegation.origin.takenOverDetail',
        { title },
    );
}

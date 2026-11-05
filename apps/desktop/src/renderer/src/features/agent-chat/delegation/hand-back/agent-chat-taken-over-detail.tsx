import { useTranslation } from '../../../../i18n';
import { AgentChatOriginParentLink } from '../agent-chat-origin-parent-link';
import type { HandBackProperties } from './agent-chat-hand-back-properties';
import { useHandBackView } from './use-hand-back-view';

/**
 * What a taken-over origin row says after "Taken over": that the replies no longer go back to the parent, or that a
 * hand-back is waiting for it. The parent's name is the row's only way back to it.
 */
export function AgentChatTakenOverDetail({
    isBusy,
    origin,
    terminalId,
    title,
}: HandBackProperties) {
    const { t } = useTranslation();
    const view = useHandBackView(terminalId, origin, isBusy);
    const isPending = view.kind === 'pending';
    return (
        <>
            {t(
                isPending
                    ? 'delegation.origin.handBackPending'
                    : 'delegation.origin.takenOverDetail',
            )}{' '}
            <AgentChatOriginParentLink
                isArchived={origin.isParentArchived}
                parentId={origin.parent.id}
                title={title}
            />
            {isPending && ` · ${t('delegation.origin.handBackPendingDetail')}`}
        </>
    );
}

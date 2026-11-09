import { useTranslation } from '../../../../i18n';
import { useDelegationOrigin } from '../hooks/use-delegation-origin';
import { AgentChatOriginParentLink } from '../origin/agent-chat-origin-parent-link';
import type { HandBackProperties } from './agent-chat-hand-back-properties';
import { useHandBackView } from './use-hand-back-view';

/**
 * What a taken-over origin row says after "Taken over": that the replies no longer go back to the parent, or that a
 * hand-back is waiting for it, saying so when Caxri handed it back after the user left. The parent's name is the row's
 * only way back to it.
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
    const lastChange = useDelegationOrigin(terminalId).controlChanges?.at(-1);
    const isAuto = lastChange?.kind === 'handed_back' && lastChange.trigger === 'auto';
    return (
        <>
            {t(
                isPending
                    ? isAuto
                        ? 'delegation.origin.handBackPendingAuto'
                        : 'delegation.origin.handBackPending'
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

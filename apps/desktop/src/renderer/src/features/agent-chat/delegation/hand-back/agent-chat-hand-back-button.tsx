import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

import { useTranslation } from '../../../../i18n';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { useDelegationHandBack } from '../../../delegation/hooks/use-delegation-hand-back';
import { HAND_BACK_BLOCK_KEYS } from '../agent-chat-delegation-origin';
import type { HandBackProperties } from './agent-chat-hand-back-properties';
import { useHandBackView } from './use-hand-back-view';

/**
 * The small "Hand back" button in the origin row of a Session the user took over, with a tooltip naming the Agent that
 * continues. It is a button, not a link, so it reads differently from the parent's name, which navigates. Always
 * rendered while the user holds the Session, but inert (`aria-disabled`, dimmed) while handing back could not work; its
 * tooltip then says why instead of a second line in the row. Nothing once the Session is delegated again or the
 * hand-back is pending. With `agents.delegation.autoHandBack` on, the tooltip also says the Session goes back on its
 * own once the user leaves it.
 */
export function AgentChatHandBackButton({
    delegationId,
    isBusy,
    origin,
    terminalId,
    title,
}: HandBackProperties & {
    /**
     * The Session's newest task; the Server continues the newest one that ran, whichever task is named.
     */
    delegationId: string | undefined;
}) {
    const { t } = useTranslation();
    const view = useHandBackView(terminalId, origin, isBusy);
    const { handBack, isPending } = useDelegationHandBack();
    const isAutoHandBackOn = useWorkbenchStore(
        (state) => state.bootstrap?.settings['agents.delegation'].autoHandBack !== false,
    );
    if (view.kind !== 'available') return null;
    let tooltipKey: Parameters<typeof t>[0] = 'delegation.origin.handBackTooltip';
    if (view.block) tooltipKey = HAND_BACK_BLOCK_KEYS[view.block];
    else if (isAutoHandBackOn) tooltipKey = 'delegation.origin.handBackTooltipAuto';
    return (
        <Tooltip content={t(tooltipKey, { title })}>
            <Button
                aria-disabled={view.block !== undefined || isPending}
                aria-label={t('delegation.origin.handBackAria', { title })}
                className="flex-none"
                size="sm"
                variant="secondary"
                onClick={() => {
                    if (!delegationId || isPending || view.block) return;
                    handBack(delegationId);
                }}
            >
                {t('delegation.origin.handBack')}
            </Button>
        </Tooltip>
    );
}

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

import { useTranslation } from '../../../../i18n';
import { useDelegationHandBack } from '../../../delegation/hooks/use-delegation-hand-back';
import type { HandBackProperties } from './agent-chat-hand-back-properties';
import { useHandBackView } from './use-hand-back-view';

/**
 * The small "Hand back" button in the origin row of a Session the user took over, with a tooltip naming the Agent that
 * continues. It is a button, not a link, so it reads differently from the "Back to <parent>" navigation link beside it.
 * Always rendered while the user holds the Session, but inert (`aria-disabled`, dimmed) while handing back could not
 * work; the line beneath it says why. Nothing once the Session is delegated again or the hand-back is pending.
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
    if (view.kind !== 'available') return null;
    return (
        <Tooltip content={t('delegation.origin.handBackTooltip', { title })}>
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

import { useTranslation } from '../../../../i18n';
import { useDelegationHandBack } from '../../../delegation/hooks/use-delegation-hand-back';
import type { HandBackProperties } from './agent-chat-hand-back-properties';
import { useHandBackView } from './use-hand-back-view';

/**
 * "Hand back to <parent>" in the origin row of a Session the user took over. Always rendered while the user holds the
 * Session, but inert (`aria-disabled`, muted) while handing back could not work; the line beneath it says why. Nothing
 * once the Session is delegated again or the hand-back is pending.
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
        <button
            aria-disabled={view.block !== undefined || isPending}
            className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-[12px] text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent aria-disabled:cursor-default aria-disabled:text-muted aria-disabled:no-underline"
            type="button"
            onClick={() => {
                if (!delegationId || isPending || view.block) return;
                handBack(delegationId);
            }}
        >
            {t('delegation.origin.handBack', { title })}
        </button>
    );
}

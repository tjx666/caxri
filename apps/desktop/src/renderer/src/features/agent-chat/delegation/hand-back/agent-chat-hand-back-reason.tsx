import { useTranslation } from '../../../../i18n';
import { HAND_BACK_BLOCK_KEYS } from '../agent-chat-delegation-origin';
import type { HandBackProperties } from './agent-chat-hand-back-properties';
import { useHandBackView } from './use-hand-back-view';

/**
 * The muted second line that says why the hand-back button is inert.
 */
export function AgentChatHandBackReason({ isBusy, origin, terminalId, title }: HandBackProperties) {
    const { t } = useTranslation();
    const view = useHandBackView(terminalId, origin, isBusy);
    if (view.kind !== 'available' || !view.block) return null;
    return <span className="min-w-0 pl-5">{t(HAND_BACK_BLOCK_KEYS[view.block], { title })}</span>;
}

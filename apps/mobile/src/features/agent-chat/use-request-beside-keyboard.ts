import { useTranslation } from '../../i18n';
import { agentChatRequestDock } from './agent-chat-request-flow';
import type { AgentChatController } from './use-agent-chat';
import { useIsKeyboardShown } from './use-keyboard-shown';

/**
 * Whether a request card waits in the dock while the keyboard is up. The card needs its question, answer field, and
 * buttons beside the keyboard; on a phone the timeline's floor and the dock's 80% cap left it too short for them, so
 * meanwhile the timeline yields its share to the card.
 */
export const useIsRequestBesideKeyboard = (chat: AgentChatController): boolean => {
    const { t } = useTranslation();
    const isKeyboardShown = useIsKeyboardShown();
    if (!isKeyboardShown) return false;
    const requests = chat.snapshot?.requests ?? [];
    return (
        agentChatRequestDock(requests, chat.pending.answeredRequestIds, t).currentId !== undefined
    );
};

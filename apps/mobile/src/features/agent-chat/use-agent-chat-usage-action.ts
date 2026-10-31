import { useCallback, useState } from 'react';

import { showToast } from '../../components/toast-store';
import { useTranslation } from '../../i18n';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { AgentChatUsageAction } from './agent-chat-usage-actions';
import { AGENT_CHAT_USAGE_ACTION_FAILURES } from './agent-chat-usage-actions';

/**
 * Runs a usage card's action on one Chat, one at a time: `pending` names the action on its way, so its button shows a
 * spinner and the card's other buttons wait. The result arrives on the Chat's snapshot (the wait ends, the hand-off
 * document lands, the guard lifts), so nothing is returned; a refusal is a toast in Desktop's words.
 */
export const useAgentChatUsageAction = (terminalId: string) => {
    const { request } = useMobileClient();
    const { t } = useTranslation();
    const [pending, setPending] = useState<AgentChatUsageAction>();
    const run = useCallback(
        async (action: AgentChatUsageAction, turnId?: string): Promise<void> => {
            if (pending) return;
            setPending(action);
            try {
                switch (action) {
                    case 'cancel':
                    case 'continueNow': {
                        if (!turnId) return;
                        await request('mobile.agentChat.usageLimitWait', {
                            terminalId,
                            turnId,
                            action,
                        });
                        break;
                    }
                    case 'generateHandoff':
                    case 'bypassUsageGuard': {
                        await request(`mobile.agentChat.${action}`, { terminalId });
                        break;
                    }
                }
            } catch {
                showToast('error', t(AGENT_CHAT_USAGE_ACTION_FAILURES[action]));
            } finally {
                setPending(undefined);
            }
        },
        [pending, request, t, terminalId],
    );
    return { pending, run };
};

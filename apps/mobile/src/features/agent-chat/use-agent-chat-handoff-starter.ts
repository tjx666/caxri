import { useCallback } from 'react';

import * as Crypto from 'expo-crypto';

import { showToast } from '../../components/toast-store';
import { useTranslation } from '../../i18n';
import type { AgentChatHandoffSource } from './agent-chat-handoff';
import { agentChatHandoffText } from './agent-chat-handoff';
import { sendAgentChatMessageOptimistically } from './agent-chat-pending';
import type { AgentChatController } from './use-agent-chat';

/**
 * Sends a `/new-session` draft from the Chat as the composer would, without touching the draft the user is writing (the
 * issue card's button): the same hand-off instructions, a pending row until Server Core takes it. A Chat whose Project
 * or Agent is unknown says so in a toast instead of sending the bare command; a failed send reports why, as the
 * composer's does.
 */
export const useAgentChatHandoffStarter = (
    chat: AgentChatController,
    source: AgentChatHandoffSource,
): ((draft: string) => Promise<void>) => {
    const { t } = useTranslation();
    const { projectId, providerId, sessionId } = source;
    return useCallback(
        async (draft) => {
            const text = agentChatHandoffText(draft, { projectId, providerId, sessionId });
            if (!text) {
                showToast('error', t('chat.handoff.unavailable'));
                return;
            }
            if (chat.pendingKey === null) return;
            await sendAgentChatMessageOptimistically({
                clearComposer: () => {},
                key: chat.pendingKey,
                message: { id: Crypto.randomUUID(), text, imageUris: [], delivery: undefined },
                reportError: (message) => {
                    if (message !== null) showToast('error', message);
                },
                returnUnsent: () => {},
                send: () => chat.send(text),
                snapshot: chat.snapshot,
            });
        },
        [chat, projectId, providerId, sessionId, t],
    );
};

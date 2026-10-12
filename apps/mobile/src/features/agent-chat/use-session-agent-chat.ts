import type { AgentProvider } from '@caxri/protocol';

import type { MobileTerminal } from '../sessions/session-model';
import {
    agentChatProviderId,
    agentChatProviderName,
    canAttachAgentChatImages,
    isAgentChatHandedOff,
    isAgentChatTerminal,
} from './agent-chat-model';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChat } from './use-agent-chat';

export interface SessionAgentChat {
    controller: AgentChatController;
    hasItems: boolean;
    /**
     * The Chat was detached for another client; see `isAgentChatHandedOff`.
     */
    isHandedOff: boolean;
    provider: string;
    /**
     * The provider's id, which decides the permission levels and plan mode the composer offers.
     */
    providerId: AgentProvider | undefined;
    /**
     * The provider accepts images in a Chat message (`chatImages`); Grok does not, so its composer has no attach
     * button.
     */
    supportsImages: boolean;
}

/**
 * The Session's Chat, or `null` when its primary Terminal is a PTY. The Chat is observed only while `isObserved`, so a
 * hidden Session or another tab does not hold a subscription.
 */
export const useSessionAgentChat = ({
    isObserved,
    terminal,
}: {
    isObserved: boolean;
    terminal: MobileTerminal | undefined;
}): SessionAgentChat | null => {
    const isChat = isAgentChatTerminal(terminal);
    const controller = useAgentChat({
        enabled: isChat && isObserved,
        terminalId: isChat ? (terminal?.id ?? null) : null,
    });
    if (!isChat) return null;
    return {
        controller,
        hasItems: (controller.snapshot?.items.length ?? 0) > 0,
        isHandedOff: isAgentChatHandedOff(terminal),
        provider: agentChatProviderName(terminal),
        providerId: agentChatProviderId(terminal),
        supportsImages: canAttachAgentChatImages(terminal),
    };
};

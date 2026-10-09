import type { MobileTerminal } from '../sessions/session-model';
import { agentChatProviderName, isAgentChatTerminal } from './agent-chat-model';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChat } from './use-agent-chat';

export interface SessionAgentChat {
    controller: AgentChatController;
    hasItems: boolean;
    provider: string;
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
        provider: agentChatProviderName(terminal),
    };
};

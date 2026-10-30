import type { ReactNode } from 'react';

import type { AgentChatHandoffSource } from './agent-chat-handoff';
import { AgentChatHandoffStarter, AgentChatSessionId } from './agent-chat-handoff';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatHandoffStarter } from './use-agent-chat-handoff-starter';

/**
 * Gives the Chat's timeline what a `/new-session` hand-off card needs: the Chat's own Session, to find the Session its
 * hand-off started, and, for a device that can message the Chat, the way to start a hand-off from an issue card.
 */
export const AgentChatHandoffScope = ({
    canSend,
    chat,
    children,
    source,
}: {
    canSend: boolean;
    chat: AgentChatController;
    children: ReactNode;
    source: AgentChatHandoffSource;
}) => {
    const startHandoff = useAgentChatHandoffStarter(chat, source);
    return (
        <AgentChatSessionId value={source.sessionId}>
            <AgentChatHandoffStarter value={canSend ? startHandoff : undefined}>
                {children}
            </AgentChatHandoffStarter>
        </AgentChatSessionId>
    );
};

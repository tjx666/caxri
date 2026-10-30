import type { AgentProvider } from '@caxri/protocol';

import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { allMobileSessions } from '../sessions/hooks/use-session-polling';
import type { AgentChatHandoffSource } from './agent-chat-handoff';

/**
 * What a `/new-session` draft sent from this Chat names: its Session, that Session's Project (read from the phone's
 * Session list), and its Agent.
 */
export const useAgentChatHandoffSource = (
    sessionId: string,
    providerId: AgentProvider | undefined,
): AgentChatHandoffSource => {
    const { sessions } = useHostSessions();
    const projectId = allMobileSessions(sessions.sections).find(
        ({ id }) => id === sessionId,
    )?.projectId;
    return { projectId, providerId, sessionId };
};

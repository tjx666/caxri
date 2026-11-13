import {
    CaxriError,
    isChatTerminal,
    isTopLevelProject,
    relayedSessionMessage,
} from '@caxri/protocol';

import type { AgentChatService } from './agent-chat';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { TerminalManager } from './terminal';

interface AgentSessionSendOptions {
    agentChat: Pick<AgentChatService, 'send'>;
    database: CaxriDatabase;
    terminals: Pick<TerminalManager, 'agentLaunchId' | 'submitAgentExact'>;
}

/**
 * Relays a message the user asked one Agent to pass on into another of the user's Sessions, the way the user would by
 * typing it there and pressing Enter. A Chat receives it through the composer's own `steer` delivery: an idle Chat
 * starts a turn, a running one takes it in after its current tool call, and one whose turn refuses steering queues it.
 * A Terminal Agent receives a submit pinned to its current launch.
 *
 * Every visible Session qualifies, not only the ones the caller created: the user asked for this relay, and refusing it
 * only made them copy the text by hand. The caller's own Session is refused (it already holds the conversation), as are
 * archived Sessions, hidden or nested Projects, and Sessions without an Agent. Delivery counts as `delegation` input
 * rather than human input, so relaying into a delegated child does not take its task over from its parent.
 */
export function createAgentSessionSendHandler({
    agentChat,
    database,
    terminals,
}: AgentSessionSendOptions): Pick<DomainHandlers, 'agent.session.sendInternal'> {
    return {
        'agent.session.sendInternal': async ({ callerTerminalId, principal, sessionId, text }) => {
            const caller = database.getTerminal(callerTerminalId);
            if (!caller || principal.kind !== 'agent')
                throw new CaxriError(
                    'FORBIDDEN',
                    'Relaying a message requires an authorized Agent',
                );
            if (caller.sessionId === sessionId)
                throw new CaxriError(
                    'VALIDATION',
                    'This is your own Session; answer the user here instead of relaying',
                );
            const session = database.getSession(sessionId);
            const project =
                session &&
                database
                    .listVisibleProjects()
                    .find((candidate) => candidate.id === session.projectId);
            if (
                !session ||
                !project ||
                !isTopLevelProject(project) ||
                session.archivedAt !== undefined
            )
                throw new CaxriError('NOT_FOUND', 'Session not found');
            const terminalId = session.primaryAgentTerminalId;
            const terminal = terminalId ? database.getTerminal(terminalId) : undefined;
            if (!terminalId || terminal?.sessionId !== sessionId || !terminal.provider)
                throw new CaxriError('CONFLICT', 'That Session has no Agent to relay to');
            const message = relayedSessionMessage(
                database.getSession(caller.sessionId)?.title,
                text,
            );
            if (isChatTerminal(terminal)) {
                await agentChat.send(terminalId, { text: message }, 'steer', 'delegation');
                return { sessionId, terminalId, delivery: 'chat' as const };
            }
            const launchId = terminals.agentLaunchId(terminalId);
            if (!launchId)
                throw new CaxriError(
                    'UNAVAILABLE',
                    "That Session's Terminal Agent is not running; ask the user to start it",
                );
            const result = await terminals.submitAgentExact(
                terminalId,
                sessionId,
                launchId,
                message,
                undefined,
                'delegation',
            );
            if (result !== 'accepted')
                throw new CaxriError(
                    'UNAVAILABLE',
                    result === 'unknown'
                        ? 'Delivery to the Terminal Agent is unconfirmed; read that Session before sending again'
                        : 'The Terminal Agent did not accept the message',
                );
            return { sessionId, terminalId, delivery: 'terminal' as const };
        },
    };
}

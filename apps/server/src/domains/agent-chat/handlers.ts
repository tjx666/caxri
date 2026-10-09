import type { DomainHandlers } from '../domain-services';
import type { AgentChatService } from './service';

/**
 * Core methods a Client uses to read and drive a Chat Terminal.
 */
export function createAgentChatHandlers(
    agentChat: AgentChatService,
): Pick<
    DomainHandlers,
    'agentChat.interrupt' | 'agentChat.read' | 'agentChat.respond' | 'agentChat.send'
> {
    return {
        'agentChat.read': ({ terminalId }) => agentChat.read(terminalId),
        'agentChat.send': async ({ terminalId, text }) => {
            await agentChat.send(terminalId, text);
            return null;
        },
        'agentChat.interrupt': async ({ terminalId }) => {
            await agentChat.interrupt(terminalId);
            return null;
        },
        'agentChat.respond': ({ terminalId, requestId, response }) => {
            agentChat.respond(terminalId, requestId, response);
            return null;
        },
    };
}

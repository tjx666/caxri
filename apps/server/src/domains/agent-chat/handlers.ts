import type { DomainHandlers } from '../domain-services';
import type { AgentChatService } from './service';

/**
 * Core methods a Client uses to read and drive a Chat Terminal.
 */
export function createAgentChatHandlers(
    agentChat: AgentChatService,
): Pick<
    DomainHandlers,
    | 'agentChat.configure'
    | 'agentChat.interrupt'
    | 'agentChat.read'
    | 'agentChat.respond'
    | 'agentChat.runCommand'
    | 'agentChat.send'
> {
    return {
        'agentChat.read': ({ terminalId }) => agentChat.read(terminalId),
        'agentChat.send': async ({ terminalId, text, images }) => {
            await agentChat.send(terminalId, { text, ...(images && { images }) });
            return null;
        },
        'agentChat.runCommand': async ({ terminalId, name, arguments: arguments_ }) => {
            await agentChat.runCommand(terminalId, name, arguments_);
            return null;
        },
        'agentChat.configure': async ({ terminalId, model, effort }) => {
            await agentChat.configure(terminalId, {
                ...(model !== undefined && { model }),
                ...(effort !== undefined && { effort }),
            });
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

import type { ExtensionCommandResult, Principal } from '@caxri/protocol';
import {
    agentPromptText,
    agentProviderCatalog,
    CaxriError,
    isChatTerminal,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
} from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import type { MobileOperationForwarder } from './agent-chat-requests';
import { sessionForPrincipal } from './session-management';

/**
 * Runs `caxri.sendToAgent` for a paired device, the Workbench command an extension's tree action (the Status panel's
 * `Resolve conflicts` or `Fix`) uses to hand a prepared prompt to the Session's Agent. Desktop's Renderer resolves it
 * there; a phone has no Renderer, so Server Core sends the prompt to the Session's primary Agent when that is a Chat
 * (the one the phone shows as the Session's conversation; a PTY Agent is never targeted, ADR 0015) through the same
 * `agentChat.send` admission `mobile.agentChat.send` uses.
 *
 * Sending starts an Agent turn, so only a `control` device may. The prompt goes through the same normalization as
 * Desktop's (`agentPromptText`), and `reauthorize` runs before the send so a revocation while the Chat list loads
 * wins.
 */
export async function sendTreePromptToSessionAgent(
    commandArguments: readonly unknown[],
    sessionId: string,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    forward: MobileOperationForwarder | undefined,
    reauthorize: () => unknown,
): Promise<ExtensionCommandResult> {
    if (principal.role !== 'control')
        throw new CaxriError('FORBIDDEN', 'Control access is required to send to the Agent');
    const text = agentPromptText(commandArguments[0]);
    if (!text) throw new CaxriError('VALIDATION', 'This action carries no prompt to send');
    if (text.length > MAX_AGENT_CHAT_MESSAGE_LENGTH)
        throw new CaxriError('VALIDATION', 'The prompt is too long to send');
    if (!forward)
        throw new CaxriError('UNAVAILABLE', 'Agent Chat is unavailable to paired devices');
    const [{ primaryAgentTerminalId }, { terminals }] = await Promise.all([
        sessionForPrincipal(domainService, principal, sessionId),
        domainService.request('terminal.queryForPrincipal', {
            principal,
            query: { mode: 'list', sessionId },
        }),
    ]);
    const chat = terminals.find(
        (terminal) =>
            terminal.id === primaryAgentTerminalId &&
            terminal.provider !== undefined &&
            isChatTerminal(terminal),
    );
    if (!chat?.provider)
        throw new CaxriError('CONFLICT', 'No Agent Chat in this Session to send to');
    reauthorize();
    await forward({ method: 'agentChat.send', params: { terminalId: chat.id, text } });
    reauthorize();
    return {
        executed: true,
        message: `Sent to ${agentProviderCatalog[chat.provider].displayName}`,
    };
}

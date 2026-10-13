import type {
    AgentDispatchFailure,
    AgentDispatchReceipt,
    AgentEndpointRef,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { requireDispatchChats } from './chat-target';
import type { AgentDispatchServiceOptions } from './service-options';

/**
 * The receipt transitions a Chat launch reports, bound to its dispatch by `AgentDispatchService`.
 */
export interface ChatLaunchReceipt {
    update(patch: {
        status: AgentDispatchReceipt['status'];
        terminalId?: string;
        endpoint?: AgentEndpointRef;
        failure?: AgentDispatchFailure;
    }): AgentDispatchReceipt;
    interrupt(): AgentDispatchReceipt;
    fail(error: unknown): AgentDispatchReceipt;
}

/**
 * `resume`/`wake` of a Chat Terminal. A Chat has no PTY to restart: this starts its provider again on the bound Agent
 * Session through the Chat restart path, which keeps the conversation and its queued follow-ups, and resolves once that
 * start settled. The receipt turns `running` only when the Chat is ready and its Agent Endpoint is active, after the
 * dispatch prompt was accepted as the Chat's next message. A Chat that comes up without an active Endpoint is stopped
 * again, as a PTY launch is. Later stops and failures settle the receipt through
 * `AgentChatServiceOptions.onAgentStateChanged`.
 */
export async function launchChat(
    options: Pick<AgentDispatchServiceOptions, 'agentChat' | 'database' | 'emit' | 'endpoints'>,
    launch: { terminal: TerminalRecord; initialPrompt?: string; shouldStart?: () => boolean },
    receipt: ChatLaunchReceipt,
): Promise<AgentDispatchReceipt> {
    const { database, endpoints } = options;
    const { terminal, initialPrompt, shouldStart } = launch;
    try {
        const chats = requireDispatchChats(terminal, options.agentChat);
        await chats.restart(terminal.id);
        if (shouldStart && !shouldStart()) return receipt.interrupt();
        if (
            !chats.isLive(terminal.id) ||
            database.getTerminal(terminal.id)?.lastAgentProcessState !== 'running'
        )
            throw new CaxriError('UNAVAILABLE', 'Managed Agent did not become running');
        const endpoint = endpoints?.endpointForTerminal(terminal.id);
        if (!endpoint) {
            await chats.stopProvider(terminal.id);
            throw new CaxriError('UNAVAILABLE', 'Agent Endpoint did not become active');
        }
        if (initialPrompt) await chats.send(terminal.id, { text: initialPrompt });
        const running = receipt.update({
            status: 'running',
            terminalId: terminal.id,
            endpoint: endpoint.ref,
        });
        database.touchSessionActivity(terminal.sessionId, 'agent_started');
        options.emit({
            event: 'state.changed',
            payload: {
                kind: 'records',
                sessionIds: [terminal.sessionId],
                terminalIds: [terminal.id],
            },
        });
        return running;
    } catch (error) {
        return receipt.fail(error);
    }
}

import type {
    AgentDispatchFailure,
    AgentDispatchReceipt,
    AgentEndpointRef,
    AgentLaunchSettings,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { DispatchChats } from './chat-target';
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
 * Hands a delegated launch to the Chat that runs it, before the start that must use it: the task's frozen launch
 * settings, its delegation id, and the conversation id a fresh Claude Code child presets. A non-delegated launch keeps
 * the Chat's own settings.
 */
export function prepareDelegatedChat(
    chats: DispatchChats | undefined,
    terminal: TerminalRecord,
    launch: {
        launch?: AgentLaunchSettings;
        delegationId?: string;
        assignedAgentSessionId?: string;
    },
): void {
    if (!launch.delegationId || !launch.launch) return;
    requireDispatchChats(terminal, chats).delegation?.prepareStart(terminal.id, {
        launch: launch.launch,
        delegationId: launch.delegationId,
        agentSessionId: launch.assignedAgentSessionId,
    });
}

/**
 * Starts the provider of a Chat Terminal for dispatch. A fresh delegated child starts the new Chat, joining a start a
 * Client's first read already began; its delegated launch was prepared when the Terminal was created, before any Client
 * could see it. Any other launch, including `resume`/`wake`, which has no PTY to restart, starts the provider through
 * the Chat restart path, which keeps the conversation and its queued follow-ups. Either resolves once that start
 * settled. The receipt turns `running` only when the Chat is ready and its Agent Endpoint is active, after the dispatch
 * prompt was accepted as the Chat's next message. A Chat that comes up without an active Endpoint is stopped again, as
 * a PTY launch is. Later stops and failures settle the receipt through `AgentChatServiceOptions.onAgentStateChanged`.
 */
export async function launchChat(
    options: Pick<AgentDispatchServiceOptions, 'agentChat' | 'database' | 'emit' | 'endpoints'>,
    launch: {
        terminal: TerminalRecord;
        initialPrompt?: string;
        shouldStart?: () => boolean;
        isFresh: boolean;
        launchSettings?: AgentLaunchSettings;
        delegationId?: string;
    },
    receipt: ChatLaunchReceipt,
): Promise<AgentDispatchReceipt> {
    const { database, endpoints } = options;
    const { terminal, initialPrompt, shouldStart } = launch;
    try {
        const chats = requireDispatchChats(terminal, options.agentChat);
        if (launch.isFresh && launch.delegationId && chats.start) await chats.start(terminal.id);
        else {
            prepareDelegatedChat(chats, terminal, { ...launch, launch: launch.launchSettings });
            await chats.restart(terminal.id);
        }
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
        // The dispatch's own prompt, like a PTY launch argument, is not human input.
        if (initialPrompt)
            await chats.send(terminal.id, { text: initialPrompt }, 'queue', 'delegation');
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

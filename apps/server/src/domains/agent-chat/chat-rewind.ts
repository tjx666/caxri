import type { AgentChatMessageInput, AgentChatRewindRefusal } from '@caxri/protocol';
import {
    agentChatRewindTarget,
    agentProviderCatalog,
    CaxriError,
    errorMessage,
} from '@caxri/protocol';
import { assertE2EAgentChatInput, logEventCatalog, readE2EAgentPolicy } from '@caxri/system';

import { requireChatTerminal } from './chat-launch';
import type { ChatResumePoint } from './chat-provider';
import type { ChatStateDelivery } from './chat-states';
import type { AgentChatServiceOptions } from './service-options';

const REWIND_REFUSALS: Record<AgentChatRewindRefusal, string> = {
    turnRunning: 'Stop the running turn before editing an earlier message',
    notTurnStart:
        'This message joined a turn that was already running, so the conversation cannot rewind to it',
    unknownMessage: 'This message is no longer in the conversation',
};

const RESTORE_REFUSALS: Record<AgentChatRewindRefusal, string> = {
    turnRunning: 'Stop the running turn before restoring code',
    notTurnStart:
        'This message joined a turn that was already running, so its code cannot be restored on its own',
    unknownMessage: 'This message is no longer in the conversation',
};

export interface ChatRewindRequest {
    itemId: string;
    restoreFiles: boolean;
    message: Omit<AgentChatMessageInput, 'delivery'>;
}

/**
 * The parts of `AgentChatService` a rewind drives: the per-Chat send chain, a restart that keeps the Agent's autonomy
 * (resuming at `resumeAt` when given), and the send that follows.
 */
interface ChatRewindHost {
    options: AgentChatServiceOptions;
    enqueue: (terminalId: string, deliver: ChatStateDelivery) => Promise<void>;
    restart: (terminalId: string, resumeAt: string | undefined) => Promise<unknown>;
    send: (terminalId: string, message: Omit<AgentChatMessageInput, 'delivery'>) => Promise<void>;
}

/**
 * "Edit from here": rewinds the provider's own record to just before user message `itemId` (restoring the files the
 * removed turns changed when asked), restarts the Chat so the projection is rebuilt from the rewound record, and sends
 * the edited message as the next turn. The rewind and the send happen in one request so a provider that rewinds by
 * resuming at an earlier point (Claude Code) writes the new branch right away: an abandoned branch is never the newest
 * record a later resume would pick up. Logs `agent_chat.rewound` with a closed outcome.
 */
export async function rewindChat(
    host: ChatRewindHost,
    terminalId: string,
    request: ChatRewindRequest,
): Promise<void> {
    assertE2EAgentChatInput(readE2EAgentPolicy(), request.message.text);
    const { provider } = requireChatTerminal(host.options.database, terminalId);
    const { restoreFiles } = request;
    const startedAt = Date.now();
    const log = (outcome: 'failed' | 'refused' | 'rewound', removedTurns?: number): void =>
        host.options.logger.write('info', logEventCatalog.agentChat.rewound, {
            fields: {
                terminalId,
                provider,
                outcome,
                restoreFiles,
                removedTurns: removedTurns ?? null,
                durationMs: Date.now() - startedAt,
            },
        });
    const providerEntry = agentProviderCatalog[provider];
    if (restoreFiles && !providerEntry.capabilities.chatRewindFiles) {
        log('refused');
        throw new CaxriError(
            'VALIDATION',
            `${providerEntry.displayName} cannot restore files; edit the message without reverting them`,
        );
    }
    let removedTurns: number | undefined;
    let resumePoint: ChatResumePoint | undefined;
    try {
        await host.enqueue(terminalId, async (session, state) => {
            const { snapshot } = state.projection;
            const result = agentChatRewindTarget(snapshot, request.itemId);
            if ('refusal' in result)
                throw new CaxriError('CONFLICT', REWIND_REFUSALS[result.refusal]);
            const item = snapshot.items.find((candidate) => candidate.id === request.itemId);
            removedTurns = result.target.removedTurns;
            resumePoint = await session.rewind({
                ...result.target,
                text: item?.type === 'userMessage' ? item.text : '',
                restoreFiles,
            });
            /**
             * Retire the rewound process before the send chain moves on, so input that arrives before the restart
             * (another client, a queued follow-up) is refused instead of reaching a conversation that was cut short.
             */
            state.retiring ??= 'replaced';
        });
    } catch (error) {
        log(
            error instanceof CaxriError &&
                (error.code === 'CONFLICT' || error.code === 'VALIDATION')
                ? 'refused'
                : 'failed',
            removedTurns,
        );
        throw error;
    }
    // Every turn is gone: the next start opens a new Agent Session instead of resuming the emptied one.
    if (resumePoint?.kind === 'fresh') host.options.coordinator.prepareTerminalStart(terminalId);
    log('rewound', removedTurns);
    try {
        await host.restart(
            terminalId,
            resumePoint?.kind === 'resumeAt' ? resumePoint.at : undefined,
        );
        await host.send(terminalId, request.message);
    } catch (error) {
        // The rewind already happened; say so, or the user would expect the old conversation to still be there.
        throw new CaxriError(
            error instanceof CaxriError ? error.code : 'UNAVAILABLE',
            `The conversation was rewound, but the message was not sent: ${errorMessage(error, 'unknown error')}`,
        );
    }
}

/**
 * The parts of `AgentChatService` a file restore drives: only the per-Chat send chain, since the conversation stays.
 */
interface ChatRestoreHost {
    options: AgentChatServiceOptions;
    enqueue: (terminalId: string, deliver: ChatStateDelivery) => Promise<void>;
}

/**
 * "Restore code to here": restores the files the turns from user message `itemId` onward changed, from the provider's
 * file checkpoints, and keeps the conversation, as Claude Code's `/rewind` offers "Restore code". The same refusals as
 * "Edit from here" apply, since the provider checkpoints files per turn-starting message. Logs
 * `agent_chat.files_restored` with a closed outcome.
 */
export async function restoreChatFiles(
    host: ChatRestoreHost,
    terminalId: string,
    itemId: string,
): Promise<void> {
    const { provider } = requireChatTerminal(host.options.database, terminalId);
    const startedAt = Date.now();
    let restoredTurns: number | undefined;
    const log = (outcome: 'failed' | 'refused' | 'restored'): void =>
        host.options.logger.write('info', logEventCatalog.agentChat.filesRestored, {
            fields: {
                terminalId,
                provider,
                outcome,
                restoredTurns: restoredTurns ?? null,
                durationMs: Date.now() - startedAt,
            },
        });
    const providerEntry = agentProviderCatalog[provider];
    if (!providerEntry.capabilities.chatRewindFiles) {
        log('refused');
        throw new CaxriError('VALIDATION', `${providerEntry.displayName} cannot restore files`);
    }
    try {
        await host.enqueue(terminalId, async (session, state) => {
            const { snapshot } = state.projection;
            const result = agentChatRewindTarget(snapshot, itemId);
            if ('refusal' in result)
                throw new CaxriError('CONFLICT', RESTORE_REFUSALS[result.refusal]);
            if (!session.restoreFiles)
                throw new CaxriError(
                    'VALIDATION',
                    `${providerEntry.displayName} cannot restore files`,
                );
            const item = snapshot.items.find((candidate) => candidate.id === itemId);
            restoredTurns = result.target.removedTurns;
            await session.restoreFiles({
                ...result.target,
                text: item?.type === 'userMessage' ? item.text : '',
                restoreFiles: true,
            });
        });
    } catch (error) {
        log(
            error instanceof CaxriError &&
                (error.code === 'CONFLICT' || error.code === 'VALIDATION')
                ? 'refused'
                : 'failed',
        );
        throw error;
    }
    log('restored');
}

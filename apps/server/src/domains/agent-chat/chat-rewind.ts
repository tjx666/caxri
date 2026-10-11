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

/**
 * Why a rewind or file restore did not happen, as `agent_chat.rewound` and `agent_chat.files_restored` record it: one
 * of the shared rewind refusals, or `capability` when the provider cannot restore files.
 */
type ChatRewindReason = AgentChatRewindRefusal | 'capability';

/**
 * The Chat declined the rewind or restore before anything changed, as opposed to a provider or Session failure.
 */
class ChatRewindRefusal extends CaxriError {
    constructor(
        readonly reason: ChatRewindReason,
        code: 'CONFLICT' | 'VALIDATION',
        message: string,
    ) {
        super(code, message);
    }
}

/**
 * A driver whose catalog entry promises file restore but whose session cannot do it: a build defect, so it logs as
 * `failed` while the user still sees the same `VALIDATION` refusal.
 */
class ChatRewindCapabilityMismatch extends CaxriError {}

/**
 * The closed log fields for a thrown rewind or restore error: a refusal is `refused` with its reason, anything else
 * `failed`, both with the CaxriError code (null for an unclassified throw).
 */
function rewindErrorFields(error: unknown): {
    outcome: 'failed' | 'refused';
    reason: ChatRewindReason | null;
    code: string | null;
} {
    const code = error instanceof CaxriError ? error.code : null;
    if (error instanceof ChatRewindRefusal)
        return { outcome: 'refused', reason: error.reason, code };
    if (error instanceof ChatRewindCapabilityMismatch)
        return { outcome: 'failed', reason: 'capability', code };
    return { outcome: 'failed', reason: null, code };
}

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
 * record a later resume would pick up. Logs `agent_chat.rewound` once, after the send: a closed outcome with its reason
 * and error code, and `resendFailed` when the rewind happened but the restart or send did not.
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
    let removedTurns: number | undefined;
    const log = (
        outcome: 'failed' | 'refused' | 'resendFailed' | 'rewound',
        reason: ChatRewindReason | null = null,
        code: string | null = null,
    ): void =>
        host.options.logger.write('info', logEventCatalog.agentChat.rewound, {
            fields: {
                terminalId,
                provider,
                outcome,
                reason,
                code,
                restoreFiles,
                removedTurns: removedTurns ?? null,
                durationMs: Date.now() - startedAt,
            },
        });
    let resumePoint: ChatResumePoint | undefined;
    try {
        const providerEntry = agentProviderCatalog[provider];
        if (restoreFiles && !providerEntry.capabilities.chatRewindFiles)
            throw new ChatRewindRefusal(
                'capability',
                'VALIDATION',
                `${providerEntry.displayName} cannot restore files; edit the message without reverting them`,
            );
        await host.enqueue(terminalId, async (session, state) => {
            const { snapshot } = state.projection;
            const result = agentChatRewindTarget(snapshot, request.itemId);
            if ('refusal' in result)
                throw new ChatRewindRefusal(
                    result.refusal,
                    'CONFLICT',
                    REWIND_REFUSALS[result.refusal],
                );
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
        const { outcome, reason, code } = rewindErrorFields(error);
        log(outcome, reason, code);
        throw error;
    }
    // Every turn is gone: the next start opens a new Agent Session instead of resuming the emptied one.
    if (resumePoint?.kind === 'fresh') host.options.coordinator.prepareTerminalStart(terminalId);
    try {
        await host.restart(
            terminalId,
            resumePoint?.kind === 'resumeAt' ? resumePoint.at : undefined,
        );
        await host.send(terminalId, request.message);
    } catch (error) {
        // The provider record is already rewound, so this is its own outcome rather than `failed`.
        log('resendFailed', null, error instanceof CaxriError ? error.code : null);
        // The rewind already happened; say so, or the user would expect the old conversation to still be there.
        throw new CaxriError(
            error instanceof CaxriError ? error.code : 'UNAVAILABLE',
            `The conversation was rewound, but the message was not sent: ${errorMessage(error, 'unknown error')}`,
        );
    }
    log('rewound');
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
 * `agent_chat.files_restored` with a closed outcome, reason, and error code.
 */
export async function restoreChatFiles(
    host: ChatRestoreHost,
    terminalId: string,
    itemId: string,
): Promise<void> {
    const { provider } = requireChatTerminal(host.options.database, terminalId);
    const startedAt = Date.now();
    let restoredTurns: number | undefined;
    const log = (
        outcome: 'failed' | 'refused' | 'restored',
        reason: ChatRewindReason | null = null,
        code: string | null = null,
    ): void =>
        host.options.logger.write('info', logEventCatalog.agentChat.filesRestored, {
            fields: {
                terminalId,
                provider,
                outcome,
                reason,
                code,
                restoredTurns: restoredTurns ?? null,
                durationMs: Date.now() - startedAt,
            },
        });
    try {
        const providerEntry = agentProviderCatalog[provider];
        if (!providerEntry.capabilities.chatRewindFiles)
            throw new ChatRewindRefusal(
                'capability',
                'VALIDATION',
                `${providerEntry.displayName} cannot restore files`,
            );
        await host.enqueue(terminalId, async (session, state) => {
            const { snapshot } = state.projection;
            const result = agentChatRewindTarget(snapshot, itemId);
            if ('refusal' in result)
                throw new ChatRewindRefusal(
                    result.refusal,
                    'CONFLICT',
                    RESTORE_REFUSALS[result.refusal],
                );
            if (!session.restoreFiles)
                throw new ChatRewindCapabilityMismatch(
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
        const { outcome, reason, code } = rewindErrorFields(error);
        log(outcome, reason, code);
        throw error;
    }
    log('restored');
}

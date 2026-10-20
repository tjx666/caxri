import { agentProviderCatalog, CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import { requireChatTerminal } from '../chat-launch';
import type { AgentChatProviderSession, ChatSideExchange } from '../chat-provider';
import type { AgentChatServiceOptions } from '../service-options';
import { EmptySideAnswerError } from './side-answer-error';

/**
 * Why a side question was not answered, for the log. Closed so the log can count causes without reading text.
 */
type SideQuestionFailure = 'unsupported' | 'notRunning' | 'timeout' | 'empty' | 'providerError';

function failureReason(error: unknown): SideQuestionFailure {
    if (error instanceof EmptySideAnswerError) return 'empty';
    return error instanceof CaxriError && error.code === 'TIMEOUT' ? 'timeout' : 'providerError';
}

/**
 * Answers one side question (`/btw`) on the Chat's running provider; see `agentChat.askSideQuestion`. It never starts a
 * provider: a side question about a conversation nobody is running has nothing to run beside, and the Client can send
 * the question as a message instead. Logs one outcome with a closed reason and the duration, never the text.
 */
export async function askChatSideQuestion(
    options: Pick<AgentChatServiceOptions, 'database' | 'logger'>,
    terminalId: string,
    session: AgentChatProviderSession | undefined,
    question: string,
    history: readonly ChatSideExchange[],
): Promise<{ response: string }> {
    const { provider } = requireChatTerminal(options.database, terminalId);
    const startedAt = Date.now();
    const log = (outcome: 'answered' | 'failed' | 'refused', reason: SideQuestionFailure | null) =>
        options.logger.write(
            outcome === 'answered' ? 'info' : 'warn',
            logEventCatalog.agentChat.sideQuestion,
            {
                fields: {
                    terminalId,
                    provider,
                    outcome,
                    reason,
                    historyLength: history.length,
                    durationMs: Date.now() - startedAt,
                },
            },
        );
    const { displayName, capabilities } = agentProviderCatalog[provider];
    if (!capabilities.chatSideQuestion || !session?.askSideQuestion) {
        if (capabilities.chatSideQuestion && !session?.isOpen) {
            log('refused', 'notRunning');
            throw new CaxriError('UNAVAILABLE', 'Start the Chat before asking a side question');
        }
        log('refused', 'unsupported');
        throw new CaxriError('VALIDATION', `${displayName} Chats cannot answer side questions`);
    }
    if (!session.isOpen) {
        log('refused', 'notRunning');
        throw new CaxriError('UNAVAILABLE', 'Start the Chat before asking a side question');
    }
    try {
        const response = await session.askSideQuestion(question, history);
        log('answered', null);
        return { response };
    } catch (error) {
        log('failed', failureReason(error));
        throw error;
    }
}

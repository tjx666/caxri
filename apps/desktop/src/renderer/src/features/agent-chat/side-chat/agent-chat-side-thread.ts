import { MAX_AGENT_CHAT_SIDE_QUESTION_HISTORY } from '@caxri/protocol';

/**
 * One question asked in a side chat and what became of it. A failed exchange stays in the thread so the user can retry
 * it, but never counts as context for the questions after it.
 */
export interface SideChatExchange {
    id: string;
    question: string;
    /**
     * Why the question could not be answered, once `status` is `failed`.
     */
    error?: string;
    /**
     * The answer, once `status` is `answered`.
     */
    response?: string;
    status: 'answered' | 'failed' | 'pending';
}

/**
 * The text after `/btw ` when the composer draft is a side question, otherwise `undefined`. A bare `/btw` is not one:
 * it stays an ordinary message (or the provider's own command) instead of opening an empty side chat.
 */
export function parseAgentChatSideQuestion(draft: string): string | undefined {
    const match = /^\s*\/btw\s+(\S[\s\S]*)/.exec(draft);
    return match?.[1]?.trim();
}

/**
 * The earlier answered exchanges a follow-up question carries as context, oldest first and capped at the protocol's
 * limit. Exchanges at or after `beforeId` (a retried one and everything below it) are left out.
 */
export function agentChatSideHistory(
    exchanges: readonly SideChatExchange[],
    beforeId?: string,
): Array<{ question: string; response: string }> {
    const end = beforeId ? exchanges.findIndex(({ id }) => id === beforeId) : -1;
    const earlier = end === -1 ? exchanges : exchanges.slice(0, end);
    return earlier
        .flatMap(({ question, response, status }) =>
            status === 'answered' && response ? [{ question, response }] : [],
        )
        .slice(-MAX_AGENT_CHAT_SIDE_QUESTION_HISTORY);
}

/**
 * The first message of the Session a side chat is converted into: the answered Q&A as context, so the new Chat can
 * carry on from it. A side thread never touched the main conversation, so this is all the new Chat knows of it.
 */
export function agentChatSideSeedPrompt(exchanges: readonly SideChatExchange[]): string {
    const history = agentChatSideHistory(exchanges);
    const transcript = history
        .map(({ question, response }) => `Q: ${question}\n\nA: ${response}`)
        .join('\n\n---\n\n');
    return `This conversation continues a side chat that was held next to another Chat. The side chat so far:\n\n${transcript}\n\nAcknowledge in one short sentence; I will continue from here in my next message.`;
}

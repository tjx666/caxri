import type { AgentChatSnapshot, AgentChatWaitingChat } from '@caxri/protocol';
import {
    AGENT_CHAT_WAITING_MAX_CHATS,
    AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH,
} from '@caxri/protocol';

import { clip } from '../chat-items';

/**
 * One Chat as {@link readWaitingChats} sees it: its projection, and whether a provider is still there to answer.
 */
export interface WaitingChatSource {
    terminalId: string;
    snapshot: Pick<AgentChatSnapshot, 'items' | 'requests'>;
    isOpen: boolean;
}

/**
 * The text of the user's latest message, clipped for the card; whitespace-only messages count as none.
 */
function latestPrompt(items: AgentChatSnapshot['items']): string | undefined {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.type !== 'userMessage' || item.delegatedTask) continue;
        const text = item.text.trim();
        if (text) return clip(text, AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH);
    }
    return undefined;
}

/**
 * Every Chat with a running provider that waits on the user, in the order Server Core holds them. It only reads the
 * given in-memory projections, so it never starts a provider; a Chat whose provider is gone is skipped because nothing
 * is left to take the answer. `sessionOf` drops a Terminal whose row is already gone.
 */
export function readWaitingChats(
    sources: Iterable<WaitingChatSource>,
    sessionOf: (terminalId: string) => string | undefined,
): AgentChatWaitingChat[] {
    const chats: AgentChatWaitingChat[] = [];
    for (const { isOpen, snapshot, terminalId } of sources) {
        if (chats.length >= AGENT_CHAT_WAITING_MAX_CHATS) break;
        if (!isOpen || snapshot.requests.length === 0) continue;
        const sessionId = sessionOf(terminalId);
        if (!sessionId) continue;
        const prompt = latestPrompt(snapshot.items);
        chats.push({
            sessionId,
            terminalId,
            requests: snapshot.requests,
            ...(prompt && { prompt }),
        });
    }
    return chats;
}

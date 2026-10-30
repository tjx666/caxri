import type {
    AgentChatSnapshot,
    AgentChatWaitingChat,
    AgentChatWaitingTerminal,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import {
    AGENT_CHAT_WAITING_MAX_CHATS,
    AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH,
    agentChatImplementablePlanId,
    agentChatProposedPlanRequest,
    isChatTerminal,
} from '@caxri/protocol';

import { clip } from '../chat-items';

/**
 * One Chat as {@link readWaitingChats} sees it: its projection, and whether a provider is still there to answer.
 */
export interface WaitingChatSource {
    terminalId: string;
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'planMode' | 'requests'>;
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
        if (!isOpen) continue;
        /**
         * Codex raises no server request for a proposed plan; the approval card is derived from the transcript. It
         * still waits on the user, so it lists beside real requests (answered through `agentChat.implementPlan`).
         */
        const planId = agentChatImplementablePlanId(snapshot);
        const requests = planId
            ? [...snapshot.requests, agentChatProposedPlanRequest(planId)]
            : snapshot.requests;
        if (requests.length === 0) continue;
        const sessionId = sessionOf(terminalId);
        if (!sessionId) continue;
        const prompt = latestPrompt(snapshot.items);
        chats.push({
            kind: 'chat',
            sessionId,
            terminalId,
            requests,
            ...(prompt && { prompt }),
        });
    }
    return chats;
}

/**
 * Every PTY Terminal Agent that waits on the user: the Session's Primary Agent Terminal while the validated lifecycle
 * state says `waiting`, still running, and shown as a PTY (a Chat Terminal asks through its own request list instead).
 * Archived Sessions are skipped. Only stored rows are read, so it never touches a process. The lifecycle tracks one
 * Primary Agent per Session, so a secondary PTY Agent has no waiting state to list.
 */
export function readWaitingTerminals(
    sessions: Iterable<
        Pick<SessionRecord, 'agentActivityState' | 'archivedAt' | 'id' | 'primaryAgentTerminalId'>
    >,
    terminalOf: (
        terminalId: string,
    ) => Pick<TerminalRecord, 'lastAgentProcessState' | 'surface'> | undefined,
): AgentChatWaitingTerminal[] {
    const terminals: AgentChatWaitingTerminal[] = [];
    for (const session of sessions) {
        if (session.agentActivityState !== 'waiting' || session.archivedAt !== undefined) continue;
        const terminalId = session.primaryAgentTerminalId;
        if (!terminalId) continue;
        const terminal = terminalOf(terminalId);
        if (!terminal || isChatTerminal(terminal) || terminal.lastAgentProcessState !== 'running')
            continue;
        terminals.push({ kind: 'terminal', sessionId: session.id, terminalId });
    }
    return terminals;
}

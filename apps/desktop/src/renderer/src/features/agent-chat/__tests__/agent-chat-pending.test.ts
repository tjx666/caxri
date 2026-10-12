import type { AgentChatSnapshot } from '@caxri/protocol';
import { AGENT_CHAT_PENDING_ACCEPTED_TTL_MS } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    addAgentChatPendingAnswer,
    expireAgentChatPendingMessage,
    pruneAgentChatPending,
    selectAgentChatPendingAnswers,
    selectAgentChatPendingMessages,
    showAgentChatPendingMessage,
    useAgentChatPendingStore,
} from '../agent-chat-pending';

function snapshot(overrides: Partial<AgentChatSnapshot> = {}): AgentChatSnapshot {
    return {
        terminalId: 'terminal-1',
        revision: 1,
        status: 'ready',
        items: [],
        turns: [],
        requests: [],
        tasks: [],
        ...overrides,
    } as AgentChatSnapshot;
}

const question = {
    id: 'request-1',
    kind: 'question' as const,
    questions: [
        { id: 'color', header: 'Color', question: 'Which?', options: [], allowsOther: true },
    ],
};

afterEach(() => {
    useAgentChatPendingStore.setState({ messages: {}, answers: {} });
    vi.useRealTimers();
});

describe('pending store', () => {
    it('queues a message sent behind one still on its way, and prunes each once shown', () => {
        const idle = snapshot();
        showAgentChatPendingMessage('terminal-1', idle, {
            text: 'First',
            images: [],
            delivery: undefined,
        });
        showAgentChatPendingMessage('terminal-1', idle, {
            text: 'Second',
            images: [],
            delivery: undefined,
        });
        const select = selectAgentChatPendingMessages('terminal-1');
        expect(
            select(useAgentChatPendingStore.getState()).map((message) => message.placement),
        ).toEqual(['timeline', 'queue']);

        pruneAgentChatPending(
            'terminal-1',
            snapshot({
                activeTurnId: 't',
                items: [{ id: 'u1', type: 'userMessage', text: 'First' }],
            }),
        );
        expect(select(useAgentChatPendingStore.getState()).map((message) => message.text)).toEqual([
            'Second',
        ]);
    });

    it('drops an accepted message the projection never matched, after its bound', () => {
        vi.useFakeTimers();
        const id = showAgentChatPendingMessage('terminal-1', snapshot(), {
            text: 'Rewritten by the provider',
            images: [],
            delivery: undefined,
        });
        expireAgentChatPendingMessage('terminal-1', id);
        vi.advanceTimersByTime(AGENT_CHAT_PENDING_ACCEPTED_TTL_MS);
        expect(
            selectAgentChatPendingMessages('terminal-1')(useAgentChatPendingStore.getState()),
        ).toEqual([]);
    });

    it('keeps one pending answer per request and prunes it once settled', () => {
        addAgentChatPendingAnswer('terminal-1', { requestId: 'request-1', notice: undefined });
        addAgentChatPendingAnswer('terminal-1', { requestId: 'request-1', notice: undefined });
        const select = selectAgentChatPendingAnswers('terminal-1');
        expect(select(useAgentChatPendingStore.getState())).toHaveLength(1);
        pruneAgentChatPending('terminal-1', snapshot({ requests: [question] }));
        expect(select(useAgentChatPendingStore.getState())).toHaveLength(1);
        pruneAgentChatPending('terminal-1', snapshot());
        expect(select(useAgentChatPendingStore.getState())).toEqual([]);
    });
});

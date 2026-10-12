import type { AgentChatSnapshot } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentChatPendingMessage } from '../agent-chat-pending';
import {
    addAgentChatPendingAnswer,
    AGENT_CHAT_PENDING_ACCEPTED_TTL_MS,
    agentChatPendingPlacement,
    expireAgentChatPendingMessage,
    isAgentChatPendingAnswerSettled,
    isAgentChatPendingMessageSettled,
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

function pending(overrides: Partial<AgentChatPendingMessage> = {}): AgentChatPendingMessage {
    return {
        id: 'pending-1',
        text: 'Run the tests',
        images: [],
        placement: 'timeline',
        knownIds: new Set(['old']),
        ...overrides,
    };
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

describe('agentChatPendingPlacement', () => {
    it('lands in the timeline when the message starts or steers a turn', () => {
        expect(agentChatPendingPlacement(snapshot(), undefined, false)).toBe('timeline');
        expect(agentChatPendingPlacement(snapshot({ activeTurnId: 't' }), 'steer', false)).toBe(
            'timeline',
        );
        // A paused queue does not hold a new message back.
        expect(
            agentChatPendingPlacement(
                snapshot({ queue: [{ id: 'q', text: 'x' }], queuePaused: true }),
                undefined,
                false,
            ),
        ).toBe('timeline');
    });

    it('lands in the queue when a turn, a compaction, the queue, or an earlier send holds it', () => {
        expect(agentChatPendingPlacement(snapshot({ activeTurnId: 't' }), undefined, false)).toBe(
            'queue',
        );
        expect(
            agentChatPendingPlacement(snapshot({ operation: 'compacting' }), 'steer', false),
        ).toBe('queue');
        expect(
            agentChatPendingPlacement(
                snapshot({ queue: [{ id: 'q', text: 'x' }] }),
                undefined,
                false,
            ),
        ).toBe('queue');
        expect(agentChatPendingPlacement(snapshot(), undefined, true)).toBe('queue');
    });
});

describe('isAgentChatPendingMessageSettled', () => {
    it('settles on a new user message or queue entry that carries its text', () => {
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({ items: [{ id: 'new', type: 'userMessage', text: 'Run the  tests\n' }] }),
            ),
        ).toBe(true);
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({ queue: [{ id: 'new', text: 'Run the tests' }] }),
            ),
        ).toBe(true);
        // The queue joined it with the message before it.
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({
                    items: [{ id: 'new', type: 'userMessage', text: 'First\n\nRun the tests' }],
                }),
            ),
        ).toBe(true);
    });

    it('stays pending while only an earlier message or another text shows', () => {
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({ items: [{ id: 'old', type: 'userMessage', text: 'Run the tests' }] }),
            ),
        ).toBe(false);
        expect(
            isAgentChatPendingMessageSettled(
                pending(),
                snapshot({ items: [{ id: 'new', type: 'userMessage', text: 'Something else' }] }),
            ),
        ).toBe(false);
        expect(isAgentChatPendingMessageSettled(pending(), undefined)).toBe(false);
    });
});

describe('isAgentChatPendingAnswerSettled', () => {
    it('settles once the request leaves or its answer record arrives', () => {
        const answer = {
            requestId: 'request-1',
            notice: { id: 'answer:request-1', type: 'notice', kind: 'answered' } as const,
        };
        expect(isAgentChatPendingAnswerSettled(answer, snapshot({ requests: [question] }))).toBe(
            false,
        );
        expect(isAgentChatPendingAnswerSettled(answer, snapshot())).toBe(true);
        expect(
            isAgentChatPendingAnswerSettled(
                answer,
                snapshot({ requests: [question], items: [answer.notice] }),
            ),
        ).toBe(true);
    });
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

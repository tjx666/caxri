import type { AgentChatRequest, AgentChatSnapshot } from '@caxri/protocol';
import { AGENT_CHAT_PENDING_ACCEPTED_TTL_MS } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    agentChatPendingKey,
    AgentChatPendingStore,
    answerAgentChatRequestOptimistically,
    sendAgentChatMessageOptimistically,
} from '../agent-chat-pending';

const KEY = agentChatPendingKey('scope', 'terminal-1');

const snapshot = (overrides: Partial<AgentChatSnapshot> = {}): AgentChatSnapshot =>
    ({
        terminalId: 'terminal-1',
        revision: 1,
        status: 'ready',
        items: [],
        turns: [],
        requests: [],
        tasks: [],
        ...overrides,
    }) as AgentChatSnapshot;

const message = (id: string, text = 'Run the tests') => ({
    id,
    text,
    imageUris: ['file:///a.jpg'],
    delivery: undefined,
});

const question: AgentChatRequest = {
    id: 'request-1',
    kind: 'question',
    questions: [
        { id: 'color', header: 'Color', question: 'Which?', options: [], allowsOther: true },
    ],
};

describe('AgentChatPendingStore', () => {
    it('places each send where it lands and counts sends for the timeline to follow', () => {
        const store = new AgentChatPendingStore();
        const listener = vi.fn();
        store.subscribe(KEY, listener);
        store.show(KEY, snapshot(), message('a'));
        store.show(KEY, snapshot(), message('b', 'Then lint'));
        const state = store.get(KEY);
        expect(state.messages.map(({ id, placement }) => [id, placement])).toEqual([
            ['a', 'timeline'],
            // A message still on its way ahead of this one makes it wait.
            ['b', 'queue'],
        ]);
        expect(state.sendCount).toBe(2);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.get(agentChatPendingKey('scope', 'other')).messages).toEqual([]);
    });

    it('counts a slash command as a send without showing a pending row', () => {
        const store = new AgentChatPendingStore();
        const listener = vi.fn();
        store.subscribe(KEY, listener);
        store.countCommand(KEY);
        expect(store.get(KEY)).toEqual({ messages: [], answers: [], sendCount: 1 });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('hands a message over once the projection shows it, keeping the send count', () => {
        const store = new AgentChatPendingStore();
        store.show(KEY, snapshot({ items: [] }), message('a'));
        const listener = vi.fn();
        store.subscribe(KEY, listener);
        store.prune(KEY, snapshot());
        expect(listener).not.toHaveBeenCalled();
        store.prune(
            KEY,
            snapshot({
                items: [{ id: 'u1', type: 'userMessage', text: 'Run the tests' }] as never,
            }),
        );
        expect(store.get(KEY)).toEqual({ messages: [], answers: [], sendCount: 1 });
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('sendAgentChatMessageOptimistically', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows the message and clears the composer before the send settles, then bounds the row by its TTL', async () => {
        const store = new AgentChatPendingStore();
        const order: string[] = [];
        const delivery = Promise.withResolvers<void>();
        const sent = sendAgentChatMessageOptimistically({
            clearComposer: () => order.push(`clear:${store.get(KEY).messages.length}`),
            key: KEY,
            message: message('a'),
            reportError: (error) => order.push(`error:${error}`),
            returnUnsent: () => order.push('return'),
            send: () => delivery.promise,
            snapshot: snapshot(),
            store,
        });
        expect(order).toEqual(['error:null', 'clear:1']);
        delivery.resolve();
        await sent;
        expect(store.get(KEY).messages).toHaveLength(1);
        vi.advanceTimersByTime(AGENT_CHAT_PENDING_ACCEPTED_TTL_MS);
        expect(store.get(KEY).messages).toEqual([]);
        expect(order).toEqual(['error:null', 'clear:1']);
    });

    it('takes a failed send away, returns it to the composer, and says why it failed', async () => {
        const store = new AgentChatPendingStore();
        const reportError = vi.fn();
        const returnUnsent = vi.fn();
        await expect(
            sendAgentChatMessageOptimistically({
                clearComposer: vi.fn(),
                key: KEY,
                message: message('a'),
                reportError,
                returnUnsent,
                send: () => Promise.reject(new Error('Caxri is reconnecting.')),
                snapshot: snapshot(),
                store,
            }),
        ).resolves.toBeUndefined();
        expect(store.get(KEY).messages).toEqual([]);
        expect(returnUnsent).toHaveBeenCalledTimes(1);
        expect(reportError).toHaveBeenLastCalledWith(
            'Your message was not sent. Reconnect to Caxri and try again.',
        );
    });
});

describe('answerAgentChatRequestOptimistically', () => {
    it("records a question's answers at once and keeps them after the answer is delivered", async () => {
        const store = new AgentChatPendingStore();
        let seen: unknown;
        await answerAgentChatRequestOptimistically({
            key: KEY,
            request: question,
            respond: () => {
                seen = store.get(KEY).answers;
                return Promise.resolve();
            },
            response: { kind: 'answers', answers: { color: ['Blue'] } },
            store,
        });
        expect(seen).toEqual(store.get(KEY).answers);
        const [answer] = store.get(KEY).answers;
        expect(answer.requestId).toBe('request-1');
        expect(answer.notice?.type).toBe('notice');
    });

    it('brings the card back and rejects when the answer fails', async () => {
        const store = new AgentChatPendingStore();
        await expect(
            answerAgentChatRequestOptimistically({
                key: KEY,
                request: { id: 'approval-1', kind: 'command' },
                respond: () => Promise.reject(new Error('offline')),
                response: { kind: 'decision', decision: 'accept' },
                store,
            }),
        ).rejects.toThrow('offline');
        expect(store.get(KEY).answers).toEqual([]);
    });
});

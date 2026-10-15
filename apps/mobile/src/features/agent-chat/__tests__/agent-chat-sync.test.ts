// oxlint-disable typescript/require-await -- Async fakes preserve the production Promise boundary.
import type { AgentChatPatch, AgentChatSnapshot } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentChatSubscriptionEvent } from '../agent-chat-sync';
import { startAgentChatReader } from '../agent-chat-sync';

const snapshot = (revision: number, text = 'Hi'): AgentChatSnapshot => ({
    terminalId: 'terminal-1',
    revision,
    status: 'ready',
    truncated: false,
    items: [{ id: 'item-1', type: 'agentMessage', text, streaming: true }],
    turns: [],
    requests: [],
});

const append = (baseRevision: number, delta: string): AgentChatPatch => ({
    terminalId: 'terminal-1',
    baseRevision,
    revision: baseRevision + 1,
    operations: [{ op: 'appendText', itemId: 'item-1', delta }],
});

const flush = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
};

const textOf = (value: AgentChatSnapshot | undefined): string | undefined =>
    (value?.items[0] as { text: string } | undefined)?.text;

function harness() {
    let emit: (event: AgentChatSubscriptionEvent) => void = () => {};
    const ack = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
    const reads: Array<PromiseWithResolvers<AgentChatSnapshot>> = [];
    const read = vi.fn(() => {
        const pending = Promise.withResolvers<AgentChatSnapshot>();
        reads.push(pending);
        return pending.promise;
    });
    const onSnapshot = vi.fn<(value: AgentChatSnapshot) => void>();
    const stop = startAgentChatReader({
        onError: vi.fn(),
        onRetry: vi.fn(),
        onSnapshot,
        read,
        subscribe: (listener) => {
            emit = listener;
            return ack.promise;
        },
    });
    return {
        ack: () => ack.resolve({ unsubscribe: async () => {} }),
        emit: (event: AgentChatSubscriptionEvent) => emit(event),
        latest: () => onSnapshot.mock.calls.at(-1)?.[0],
        onSnapshot,
        read,
        reads,
        stop,
    };
}

describe('Agent Chat reader', () => {
    afterEach(() => vi.useRealTimers());

    it('buffers text bursts without delaying the first text or the terminal patch', async () => {
        vi.useFakeTimers();
        const chat = harness();
        chat.ack();
        await vi.advanceTimersByTimeAsync(0);
        chat.reads[0]?.resolve(snapshot(1));
        await vi.advanceTimersByTimeAsync(0);
        const initialCalls = chat.onSnapshot.mock.calls.length;
        chat.emit({ kind: 'agentChat.patch', patch: append(1, ' one') });
        chat.emit({ kind: 'agentChat.patch', patch: append(2, ' two') });
        expect(chat.onSnapshot).toHaveBeenCalledTimes(initialCalls);
        await vi.advanceTimersByTimeAsync(32);
        expect(textOf(chat.latest())).toBe('Hi one two');
        expect(chat.onSnapshot).toHaveBeenCalledTimes(initialCalls + 1);
        chat.emit({ kind: 'agentChat.patch', patch: append(3, ' final') });
        chat.emit({
            kind: 'agentChat.patch',
            patch: {
                terminalId: 'terminal-1',
                baseRevision: 4,
                revision: 5,
                operations: [{ op: 'state', state: { activeTurnId: null } }],
            },
        });
        expect(textOf(chat.latest())).toBe('Hi one two final');
        expect(chat.latest()?.revision).toBe(5);
        chat.stop();
        await vi.advanceTimersByTimeAsync(32);
        expect(chat.latest()?.revision).toBe(5);
    });

    it('reads after the ACK and streams patches onto that read', async () => {
        const chat = harness();
        expect(chat.read).not.toHaveBeenCalled();
        chat.ack();
        await flush();
        expect(chat.read).toHaveBeenCalledOnce();
        chat.reads[0]?.resolve(snapshot(1));
        await flush();
        chat.emit({ kind: 'agentChat.patch', patch: append(1, ' there') });
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(textOf(chat.latest())).toBe('Hi there');
        expect(chat.latest()?.revision).toBe(2);
        chat.stop();
    });

    it('replays patches that arrived during a read only when they are newer than it', async () => {
        const chat = harness();
        chat.ack();
        await flush();
        chat.emit({ kind: 'agentChat.patch', patch: append(1, ' old') });
        chat.emit({ kind: 'agentChat.patch', patch: append(2, ' new') });
        chat.reads[0]?.resolve(snapshot(2, 'Hi old'));
        await flush();
        expect(textOf(chat.latest())).toBe('Hi old new');
        expect(chat.read).toHaveBeenCalledOnce();
        chat.stop();
    });

    it('re-reads when the revision chain breaks or the gateway reports a change it could not carry', async () => {
        const chat = harness();
        chat.ack();
        await flush();
        chat.reads[0]?.resolve(snapshot(1));
        await flush();
        chat.emit({ kind: 'agentChat.patch', patch: append(5, 'gap') });
        expect(chat.read).toHaveBeenCalledTimes(2);
        chat.reads[1]?.resolve(snapshot(6, 'fresh'));
        await flush();
        expect(textOf(chat.latest())).toBe('fresh');
        chat.emit({ kind: 'agentChat.changed' });
        expect(chat.read).toHaveBeenCalledTimes(3);
        chat.emit({ kind: 'agentChat.patch', patch: { not: 'a patch' } });
        chat.reads[2]?.resolve(snapshot(7, 'again'));
        await flush();
        // The invalid payload queued one more read behind the in-flight one.
        expect(chat.read).toHaveBeenCalledTimes(4);
        chat.stop();
    });

    it('polls when the subscription is unavailable', async () => {
        vi.useFakeTimers();
        const read = vi.fn(async () => snapshot(1));
        const stop = startAgentChatReader({
            onError: vi.fn(),
            onRetry: vi.fn(),
            onSnapshot: vi.fn(),
            read,
            subscribe: async () => {
                throw new Error('offline');
            },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(2_500);
        expect(read).toHaveBeenCalledTimes(2);
        stop();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('asks its owner to resubscribe after a resync', async () => {
        vi.useFakeTimers();
        let emit: (event: AgentChatSubscriptionEvent) => void = () => {};
        const onRetry = vi.fn();
        const stop = startAgentChatReader({
            onError: vi.fn(),
            onRetry,
            onSnapshot: vi.fn(),
            read: async () => snapshot(1),
            subscribe: async (listener) => {
                emit = listener;
                return { unsubscribe: async () => {} };
            },
        });
        await vi.advanceTimersByTimeAsync(0);
        emit({ kind: 'resync-required' });
        await vi.advanceTimersByTimeAsync(2_500);
        expect(onRetry).toHaveBeenCalledOnce();
        stop();
    });
});

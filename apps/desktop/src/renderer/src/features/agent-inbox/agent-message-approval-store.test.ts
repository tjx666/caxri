import type { AgentHeldMessage, ServerEvent } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    listeners: new Set<(event: ServerEvent, environmentId?: string) => void>(),
    request: vi.fn(),
}));
vi.mock('../../lib/caxri', () => ({
    caxri: {
        onEvent: (listener: (event: ServerEvent, environmentId?: string) => void) => {
            mocks.listeners.add(listener);
            return () => mocks.listeners.delete(listener);
        },
        request: mocks.request,
    },
}));

import { forgetEnvironment, resolveRequestEnvironment } from '../../lib/environment-routing';
import {
    activeHeldMessage,
    deferHeldMessage,
    deferredHeldMessages,
} from './agent-message-approval-state';
import {
    reviewOldestDeferredMessage,
    selectDeferredHeldMessageCount,
    subscribeHeldMessageQueue,
    updateHeldMessageQueue,
    useHeldMessageQueueStore,
} from './agent-message-approval-store';

const NOW = 1_000_000;

/**
 * Only the fields the queue orders, expires, and identifies by; the cast spares each case the sender summary.
 */
function held(messageId: string, createdAt: number): AgentHeldMessage {
    return { createdAt, expiresAt: createdAt + 60_000, messageId } as AgentHeldMessage;
}

function emit(event: ServerEvent, environmentId?: string): void {
    for (const listener of mocks.listeners) listener(event, environmentId);
}

function heldEvent(message: AgentHeldMessage): ServerEvent {
    return { event: 'agent.message.held', payload: message };
}

function receiptEvent(messageId: string, status: string): ServerEvent {
    return { event: 'agent.message.receipt', payload: { messageId, status } } as ServerEvent;
}

function deferredCount(): number {
    return selectDeferredHeldMessageCount(useHeldMessageQueueStore.getState());
}

function queue() {
    return useHeldMessageQueueStore.getState().queue;
}

async function subscribeWith(initial: AgentHeldMessage[]): Promise<() => void> {
    mocks.request.mockResolvedValueOnce({ messages: initial });
    const unsubscribe = subscribeHeldMessageQueue();
    // Settle the initial list without moving the fake expiry clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.request).toHaveBeenCalledWith('agent.message.held');
    return unsubscribe;
}

/**
 * The approval dialog, its waiting list, and the status bar count all read this one queue (issue caxri#1355), so the
 * transitions each surface triggers have to show up in the others without any of them being mounted.
 */
describe('held message queue store', () => {
    let unsubscribe: (() => void) | undefined;

    beforeEach(() => {
        vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        mocks.request.mockReset();
        mocks.listeners.clear();
        updateHeldMessageQueue(() => ({ deferred: [], messages: [] }));
    });

    afterEach(() => {
        unsubscribe?.();
        unsubscribe = undefined;
        vi.useRealTimers();
    });

    it('counts each deferral, reopens the oldest, and drops a request once it is answered', async () => {
        const first = held('held-1', NOW - 2_000);
        const second = held('held-2', NOW - 1_000);
        unsubscribe = await subscribeWith([first]);
        emit(heldEvent(second));
        expect(activeHeldMessage(queue())).toEqual(first);

        updateHeldMessageQueue((current) => deferHeldMessage(current, 'held-1'));
        expect(deferredCount()).toBe(1);
        expect(activeHeldMessage(queue())).toEqual(second);
        updateHeldMessageQueue((current) => deferHeldMessage(current, 'held-2'));
        expect(deferredCount()).toBe(2);
        expect(activeHeldMessage(queue())).toBeUndefined();

        reviewOldestDeferredMessage();
        expect(activeHeldMessage(queue())).toEqual(first);
        expect(deferredCount()).toBe(1);

        emit(receiptEvent('held-1', 'delivered'));
        expect(activeHeldMessage(queue())).toBeUndefined();
        expect(deferredHeldMessages(queue())).toEqual([second]);
        expect(deferredCount()).toBe(1);

        emit(receiptEvent('held-2', 'refused'));
        expect(deferredCount()).toBe(0);
        expect(queue().messages).toEqual([]);
    });

    it('drops an expired request on the tick without notifying readers when nothing expired', async () => {
        // Its window closes between the first and second tick.
        const expiring = held('held-1', NOW - 58_500);
        unsubscribe = await subscribeWith([expiring]);
        updateHeldMessageQueue((current) => deferHeldMessage(current, 'held-1'));
        const notified = vi.fn();
        const stopWatching = useHeldMessageQueueStore.subscribe(notified);

        vi.advanceTimersByTime(1_000);
        expect(deferredCount()).toBe(1);
        expect(notified).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1_000);
        expect(deferredCount()).toBe(0);
        expect(notified).toHaveBeenCalledOnce();
        stopWatching();
    });

    it('runs no expiry timer while the queue is empty', async () => {
        unsubscribe = await subscribeWith([]);
        expect(vi.getTimerCount()).toBe(0);
        emit(heldEvent(held('held-1', NOW)));
        expect(vi.getTimerCount()).toBe(1);
        emit(receiptEvent('held-1', 'delivered'));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps the presented request on screen as expired when the Server reports its expiry', async () => {
        const first = held('held-1', NOW - 2_000);
        const second = held('held-2', NOW - 1_000);
        unsubscribe = await subscribeWith([first, second]);

        emit(receiptEvent('held-1', 'expired'));

        expect(queue().expired).toEqual(first);
        expect(queue().messages).toEqual([second]);
        expect(activeHeldMessage(queue())).toBeUndefined();
    });

    it('keeps a request whose receipt still reports it held', async () => {
        unsubscribe = await subscribeWith([held('held-1', NOW - 1_000)]);

        emit(receiptEvent('held-1', 'held'));

        expect(queue().messages).toHaveLength(1);
    });

    it('stops following the Server after teardown', async () => {
        unsubscribe = await subscribeWith([]);
        unsubscribe();
        unsubscribe = undefined;

        emit(heldEvent(held('held-1', NOW - 1_000)));

        expect(queue().messages).toEqual([]);
    });

    describe('with an SSH Host attached', () => {
        const HOST = 'me@build-box:22';

        afterEach(() => forgetEnvironment(HOST));

        it('tags a remote held message with its Host and routes read, approve, and deny to it', async () => {
            unsubscribe = await subscribeWith([]);
            emit(heldEvent(held('remote-1', NOW)), HOST);

            expect(queue().messages).toEqual([{ ...held('remote-1', NOW), environmentId: HOST }]);
            for (const method of [
                'agent.message.held.get',
                'agent.message.approve',
                'agent.message.deny',
            ])
                expect(resolveRequestEnvironment(method, { messageId: 'remote-1' })).toBe(HOST);
            expect(
                resolveRequestEnvironment('agent.message.approve', { messageId: 'local-1' }),
            ).toBeUndefined();
        });

        it('drops a remote entry only on its own Host receipt and a local entry only on a local one', async () => {
            unsubscribe = await subscribeWith([held('shared', NOW - 1_000)]);
            emit(heldEvent(held('remote-1', NOW)), HOST);

            emit(receiptEvent('shared', 'delivered'), HOST);
            expect(queue().messages.map((message) => message.messageId)).toEqual([
                'shared',
                'remote-1',
            ]);

            emit(receiptEvent('remote-1', 'delivered'), HOST);
            expect(queue().messages.map((message) => message.messageId)).toEqual(['shared']);
            expect(
                resolveRequestEnvironment('agent.message.approve', { messageId: 'remote-1' }),
            ).toBeUndefined();

            emit(receiptEvent('shared', 'delivered'));
            expect(queue().messages).toEqual([]);
        });

        it('does not let the local initial read erase a remote entry that arrived first', async () => {
            const read = Promise.withResolvers<{ messages: AgentHeldMessage[] }>();
            mocks.request.mockReturnValueOnce(read.promise);
            unsubscribe = subscribeHeldMessageQueue();
            emit(heldEvent(held('remote-1', NOW)), HOST);
            read.resolve({ messages: [held('local-1', NOW - 1_000)] });
            await vi.advanceTimersByTimeAsync(0);

            expect(queue().messages.map((message) => message.messageId)).toEqual([
                'local-1',
                'remote-1',
            ]);
        });
    });
});

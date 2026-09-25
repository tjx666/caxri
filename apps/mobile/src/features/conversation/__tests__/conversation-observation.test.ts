import { describe, expect, it, vi } from 'vitest';

import {
    observeConversation,
    readConversationSnapshot,
    startConversationReader,
} from '../conversation-observation';

describe('Conversation observation', () => {
    it('reads only after subscribe ACK and preserves pre-ACK invalidations', async () => {
        const pending = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
        let event: (value: { kind: string }) => void = () => {};
        const subscribe = vi.fn((listener: (value: { kind: string }) => void) => {
            event = listener;
            return pending.promise;
        });
        const onReady = vi.fn();
        const onChanged = vi.fn();
        const stop = observeConversation(subscribe, onReady, onChanged, vi.fn(), vi.fn());
        event({ kind: 'conversation.changed' });
        expect(onReady).not.toHaveBeenCalled();
        pending.resolve({ unsubscribe: async () => {} });
        await Promise.resolve();
        expect(onReady).toHaveBeenCalledOnce();
        expect(onChanged).toHaveBeenCalledOnce();
        stop();
    });

    it('retires a late ACK after visibility is lost', async () => {
        const pending = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
        const unsubscribe = vi.fn(async () => {});
        const onReady = vi.fn();
        const stop = observeConversation(() => pending.promise, onReady, vi.fn(), vi.fn(), vi.fn());
        stop();
        pending.resolve({ unsubscribe });
        await Promise.resolve();
        expect(onReady).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('requests a second read when an event arrives during the first', async () => {
        let version = 0;
        const pending = Promise.withResolvers<string>();
        const changed = vi.fn();
        const read = readConversationSnapshot(
            () => pending.promise,
            () => version,
            changed,
        );
        version += 1;
        pending.resolve('snapshot');
        expect(await read).toBe('snapshot');
        expect(changed).toHaveBeenCalledOnce();
    });

    it('starts the timeline read after ACK and ignores invalidations after disposal', async () => {
        const pending = Promise.withResolvers<{ unsubscribe(): Promise<void> }>();
        let event: (value: { kind: string }) => void = () => {};
        const read = vi.fn(() => Promise.resolve('current'));
        const onResult = vi.fn();
        const unsubscribe = vi.fn(async () => {});
        const stop = startConversationReader({
            read,
            subscribe: (listener) => {
                event = listener;
                return pending.promise;
            },
            onResult,
            onError: vi.fn(),
            onRetry: vi.fn(),
        });
        expect(read).not.toHaveBeenCalled();
        pending.resolve({ unsubscribe });
        await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith('current'));
        expect(read).toHaveBeenCalledOnce();
        stop();
        event({ kind: 'conversation.changed' });
        await Promise.resolve();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledOnce();
    });
});

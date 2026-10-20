import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { caxriQueryKey, createCaxriQueryClient } from '../../../queries/client';
import {
    agentChatReadFollowOptions,
    subscribeAgentChatCacheRetention,
} from '../agent-chat-cache-retention';

const chatKey = (terminalId: string) => caxriQueryKey('agentChat.read', { terminalId });

/**
 * Mounts and unmounts a pane's read the way `useCaxriQuery` does: an observer subscribes, then leaves.
 */
function view(
    client: QueryClient,
    terminalId: string,
    { isSessionVisible = true, onChange = () => {} } = {},
): () => void {
    const observer = new QueryObserver(client, {
        queryKey: chatKey(terminalId),
        queryFn: () => ({ terminalId }),
        staleTime: Infinity,
        ...agentChatReadFollowOptions(isSessionVisible),
    });
    return observer.subscribe(onChange);
}

describe('Agent Chat cache retention', () => {
    it('keeps a left Chat cached past React Query’s five-minute default', () => {
        const client = createCaxriQueryClient();
        client.setQueryData(chatKey('chat-1'), { terminalId: 'chat-1' });
        view(client, 'chat-1')();

        // Read off the options: outside a browser React Query already defaults `gcTime` to `Infinity` itself.
        expect(client.getQueryCache().find({ queryKey: chatKey('chat-1') })?.options.gcTime).toBe(
            Infinity,
        );
        client.clear();
    });

    it('drops the Chat left longest ago once more than the limit are cached unseen', () => {
        const client = new QueryClient();
        const unsubscribe = subscribeAgentChatCacheRetention(client, 2);
        for (const id of ['chat-1', 'chat-2', 'chat-3']) {
            client.setQueryData(chatKey(id), { terminalId: id });
            view(client, id)();
        }

        expect(client.getQueryData(chatKey('chat-1'))).toBeUndefined();
        expect(client.getQueryData(chatKey('chat-2'))).toBeDefined();
        expect(client.getQueryData(chatKey('chat-3'))).toBeDefined();
        unsubscribe();
        client.clear();
    });

    it('counts Chats cached before it started as left first', () => {
        const client = new QueryClient();
        client.setQueryData(chatKey('earlier'), { terminalId: 'earlier' });
        const unsubscribe = subscribeAgentChatCacheRetention(client, 1);
        client.setQueryData(chatKey('later'), { terminalId: 'later' });
        view(client, 'later')();

        expect(client.getQueryData(chatKey('earlier'))).toBeUndefined();
        expect(client.getQueryData(chatKey('later'))).toBeDefined();
        unsubscribe();
        client.clear();
    });

    it('never drops a Chat that is on screen, and counts a revisit as the most recent', () => {
        const client = new QueryClient();
        const unsubscribe = subscribeAgentChatCacheRetention(client, 1);
        client.setQueryData(chatKey('shown'), { terminalId: 'shown' });
        const leaveShown = view(client, 'shown');
        client.setQueryData(chatKey('chat-1'), { terminalId: 'chat-1' });
        view(client, 'chat-1')();
        client.setQueryData(chatKey('chat-2'), { terminalId: 'chat-2' });
        view(client, 'chat-2')();

        expect(client.getQueryData(chatKey('shown'))).toBeDefined();
        expect(client.getQueryData(chatKey('chat-1'))).toBeUndefined();

        leaveShown();
        expect(client.getQueryData(chatKey('chat-2'))).toBeUndefined();
        expect(client.getQueryData(chatKey('shown'))).toBeDefined();
        unsubscribe();
        client.clear();
    });

    it('keeps a hidden kept-alive Chat cached and current without telling its pane about each update', () => {
        const client = new QueryClient();
        const unsubscribe = subscribeAgentChatCacheRetention(client, 1);
        client.setQueryData(chatKey('hidden'), { terminalId: 'hidden', revision: 1 });
        const onChange = vi.fn();
        view(client, 'hidden', { isSessionVisible: false, onChange });
        onChange.mockClear();
        for (const id of ['chat-1', 'chat-2']) {
            client.setQueryData(chatKey(id), { terminalId: id });
            view(client, id)();
        }

        client.setQueryData(chatKey('hidden'), { terminalId: 'hidden', revision: 2 });

        expect(onChange).not.toHaveBeenCalled();
        expect(client.getQueryData(chatKey('hidden'))).toEqual({
            terminalId: 'hidden',
            revision: 2,
        });
        expect(client.getQueryData(chatKey('chat-1'))).toBeUndefined();
        unsubscribe();
        client.clear();
    });

    it('leaves every other read to its own lifetime', () => {
        const client = new QueryClient();
        const unsubscribe = subscribeAgentChatCacheRetention(client, 0);
        client.setQueryData(
            caxriQueryKey('agentChat.readTask', { terminalId: 'chat', taskId: 't' }),
            {},
        );

        expect(
            client.getQueryData(
                caxriQueryKey('agentChat.readTask', { terminalId: 'chat', taskId: 't' }),
            ),
        ).toBeDefined();
        unsubscribe();
        client.clear();
    });
});

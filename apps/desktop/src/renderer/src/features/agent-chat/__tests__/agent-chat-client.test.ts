import type {
    AgentChatPatch,
    AgentChatSnapshot,
    AgentChatTaskPatch,
    AgentChatTaskSnapshot,
} from '@caxri/protocol';
import { emptyAgentChatSnapshot, emptyAgentChatTaskSnapshot } from '@caxri/protocol';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import { caxriQueryKey } from '../../../queries/client';
import { createAgentChatPatchCache, createAgentChatTaskPatchCache } from '../agent-chat-client';

const queryKey = caxriQueryKey('agentChat.read', { terminalId: 'chat' });

function snapshotAt(revision: number): AgentChatSnapshot {
    return { ...emptyAgentChatSnapshot('chat'), status: 'ready', revision };
}

function message(revision: number, text: string): AgentChatPatch {
    return {
        terminalId: 'chat',
        baseRevision: revision - 1,
        revision,
        operations: [{ op: 'upsertItem', item: { id: text, type: 'userMessage', text } }],
    };
}

const queryClient = new QueryClient();

afterEach(() => queryClient.clear());

/**
 * Starts a read Server Core answers later, as the real `agentChat.read` round trip does.
 */
function pendingRead(): { settle: (snapshot: AgentChatSnapshot) => Promise<unknown> } {
    const reply = Promise.withResolvers<AgentChatSnapshot>();
    const read = queryClient.query({ queryKey, queryFn: () => reply.promise });
    return {
        settle: (snapshot) => {
            reply.resolve(snapshot);
            return read;
        },
    };
}

describe('createAgentChatPatchCache', () => {
    it('replays a patch that arrived while the read was in flight', async () => {
        const cache = createAgentChatPatchCache(queryClient);
        const read = pendingRead();
        // Server Core captured revision 1 for the read, then emitted the turn's final patch before the reply landed.
        cache.apply(message(2, 'last'));
        await read.settle(snapshotAt(1));
        const cached = queryClient.getQueryData<AgentChatSnapshot>(queryKey);
        expect(cached?.revision).toBe(2);
        expect(cached?.items.map((item) => item.id)).toEqual(['last']);
        cache.dispose();
    });

    it('skips held patches the read already includes', async () => {
        const cache = createAgentChatPatchCache(queryClient);
        const read = pendingRead();
        cache.apply(message(2, 'included'));
        await read.settle(snapshotAt(2));
        expect(queryClient.getQueryData<AgentChatSnapshot>(queryKey)?.items).toEqual([]);
        cache.dispose();
    });

    it('ignores a Chat nobody has open', () => {
        const cache = createAgentChatPatchCache(queryClient);
        cache.apply(message(1, 'unseen'));
        expect(queryClient.getQueryState(queryKey)).toBeUndefined();
        cache.dispose();
    });

    it('applies a continuing patch directly and re-reads after a gap', () => {
        const cache = createAgentChatPatchCache(queryClient);
        queryClient.setQueryData(queryKey, snapshotAt(1));
        cache.apply(message(2, 'next'));
        expect(queryClient.getQueryData<AgentChatSnapshot>(queryKey)?.revision).toBe(2);
        cache.apply(message(5, 'gap'));
        expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
        cache.dispose();
    });
});

const taskQueryKey = caxriQueryKey('agentChat.readTask', { terminalId: 'chat', taskId: 'task-1' });

function taskAt(revision: number): AgentChatTaskSnapshot {
    return { ...emptyAgentChatTaskSnapshot('chat', 'task-1'), revision };
}

function output(revision: number, delta: string, taskId = 'task-1'): AgentChatTaskPatch {
    return {
        terminalId: 'chat',
        taskId,
        baseRevision: revision - 1,
        revision,
        operations: [{ op: 'appendOutput', delta }],
    };
}

describe('createAgentChatTaskPatchCache', () => {
    it('applies continuing task patches and leaves other tasks alone', () => {
        const cache = createAgentChatTaskPatchCache(queryClient);
        queryClient.setQueryData(taskQueryKey, taskAt(1));
        cache.apply(output(2, 'hello '));
        cache.apply(output(3, 'world'));
        cache.apply(output(2, 'elsewhere', 'task-2'));
        const cached = queryClient.getQueryData<AgentChatTaskSnapshot>(taskQueryKey);
        expect(cached?.revision).toBe(3);
        expect(cached?.output).toBe('hello world');
        expect(
            queryClient.getQueryState(
                caxriQueryKey('agentChat.readTask', { terminalId: 'chat', taskId: 'task-2' }),
            ),
        ).toBeUndefined();
        cache.dispose();
    });

    it('replays a task patch held while the read was in flight, and re-reads after a gap', async () => {
        const cache = createAgentChatTaskPatchCache(queryClient);
        const reply = Promise.withResolvers<AgentChatTaskSnapshot>();
        const read = queryClient.query({ queryKey: taskQueryKey, queryFn: () => reply.promise });
        cache.apply(output(2, 'tail'));
        reply.resolve(taskAt(1));
        await read;
        expect(queryClient.getQueryData<AgentChatTaskSnapshot>(taskQueryKey)?.output).toBe('tail');
        cache.apply(output(9, 'gap'));
        expect(queryClient.getQueryState(taskQueryKey)?.isInvalidated).toBe(true);
        cache.dispose();
    });
});

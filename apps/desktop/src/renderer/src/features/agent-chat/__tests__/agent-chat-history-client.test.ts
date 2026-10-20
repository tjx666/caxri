import type { AgentChatItem, AgentChatOlderHistory, AgentChatTaskSnapshot } from '@caxri/protocol';
import { emptyAgentChatTaskSnapshot, prependAgentChatHistoryPage } from '@caxri/protocol';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import { caxriQueryKey } from '../../../queries/client';
import {
    agentChatHistoryQueryKey,
    cachedAgentChatHistory,
    subscribeAgentChatHistoryRetention,
} from '../agent-chat-history-client';

const message = (id: string): AgentChatItem => ({
    id,
    type: 'agentMessage',
    text: id,
    streaming: false,
});

const taskSnapshot = (ids: string[], isCut = true): AgentChatTaskSnapshot => ({
    ...emptyAgentChatTaskSnapshot('chat', 'task-1'),
    items: ids.map((id) => message(id)),
    truncated: isCut,
});

const queryClient = new QueryClient();
const taskKey = caxriQueryKey('agentChat.readTask', { terminalId: 'chat', taskId: 'task-1' });

afterEach(() => queryClient.clear());

describe('task history retention', () => {
    it('keeps the items a task projection evicts once the tab started reading back', () => {
        const unsubscribe = subscribeAgentChatHistoryRetention(queryClient);
        queryClient.setQueryData(taskKey, taskSnapshot(['c', 'd']));
        const historyKey = agentChatHistoryQueryKey('chat', 'task-1', 'task-1');
        const read = prependAgentChatHistoryPage(
            cachedAgentChatHistory(queryClient, 'chat', 'task-1', 'task-1'),
            {
                historyId: 'task-1',
                items: [message('b')],
                turns: [],
                hasMore: true,
                truncated: false,
            },
            [],
        );
        queryClient.setQueryData(historyKey, read);

        queryClient.setQueryData(taskKey, taskSnapshot(['d', 'e']));

        const history = queryClient.getQueryData<AgentChatOlderHistory>(historyKey);
        expect(history?.items.map((item) => item.id)).toEqual(['b', 'c']);
        unsubscribe();
    });

    it('keeps a task history apart from the Chat history of the same Terminal', () => {
        expect(agentChatHistoryQueryKey('chat', 'task-1', 'task-1')).not.toEqual(
            agentChatHistoryQueryKey('chat', 'task-1'),
        );
    });
});

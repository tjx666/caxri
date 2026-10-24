import type { AgentChatHistoryPage, AgentChatItem, AgentChatOlderHistory } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { caxriQueryKey, queryClient } from '../../../../queries/client';
import { agentChatHistoryQueryKey, loadOlderAgentChatHistory } from '../agent-chat-history-client';

const readHistory = vi.hoisted(() =>
    vi.fn<(method: string, parameters: unknown) => Promise<AgentChatHistoryPage>>(),
);
vi.mock('../../../../lib/caxri', () => ({ caxri: { request: readHistory } }));

const output = (id: string): AgentChatItem => ({
    id,
    type: 'agentMessage',
    text: id,
    streaming: false,
});

const request = (id: string): AgentChatItem => ({ id, type: 'userMessage', text: id });

const page = (items: AgentChatItem[], hasMore: boolean): AgentChatHistoryPage => ({
    historyId: 'h1',
    items,
    turns: [],
    hasMore,
    truncated: false,
});

afterEach(() => {
    queryClient.clear();
    readHistory.mockReset();
});

describe('loadOlderAgentChatHistory', () => {
    it('reads past a page of Agent output until a page brings a user message', async () => {
        queryClient.setQueryData(caxriQueryKey('agentChat.read', { terminalId: 'chat' }), {
            ...emptyAgentChatSnapshot('chat'),
            historyId: 'h1',
            items: [output('a3')],
            truncated: true,
        });
        readHistory
            .mockResolvedValueOnce(page([output('a1'), output('a2')], true))
            .mockResolvedValueOnce(page([request('u0'), output('a0')], true));
        const onBeforePrepend = vi.fn();

        await loadOlderAgentChatHistory({ terminalId: 'chat' }, onBeforePrepend);

        expect(readHistory.mock.calls.map((call) => call[1])).toEqual([
            { terminalId: 'chat', beforeItemId: 'a3' },
            { terminalId: 'chat', beforeItemId: 'a1' },
        ]);
        const history = queryClient.getQueryData<AgentChatOlderHistory>(
            agentChatHistoryQueryKey('chat', 'h1'),
        );
        expect(history?.items.map((item) => item.id)).toEqual(['u0', 'a0', 'a1', 'a2']);
        expect(history?.status).toBe('idle');
        expect(onBeforePrepend).toHaveBeenCalledTimes(2);
    });
});

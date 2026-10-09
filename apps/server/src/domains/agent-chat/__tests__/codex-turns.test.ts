import {
    applyAgentChatOperation,
    emptyAgentChatSnapshot,
    MAX_AGENT_CHAT_ITEMS,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { historyOperations } from '../codex-turns';

describe('historyOperations', () => {
    it('keeps the projection marked truncated when resumed history overflows the item budget', () => {
        const items = Array.from({ length: MAX_AGENT_CHAT_ITEMS + 5 }, (_, index) => ({
            id: `m${index}`,
            type: 'agentMessage',
            text: 'reply',
        }));
        const operations = historyOperations(
            { turns: [{ id: 'turn-1', status: 'completed', items }] },
            undefined,
        );
        const snapshot = operations.reduce(
            applyAgentChatOperation,
            emptyAgentChatSnapshot('terminal-1'),
        );
        expect(snapshot.items).toHaveLength(MAX_AGENT_CHAT_ITEMS);
        expect(snapshot.truncated).toBe(true);
    });

    it('resumes a short history untruncated', () => {
        const operations = historyOperations(
            {
                turns: [
                    {
                        id: 'turn-1',
                        status: 'completed',
                        items: [{ id: 'm', type: 'agentMessage', text: 'hi' }],
                    },
                ],
            },
            undefined,
        );
        const snapshot = operations.reduce(
            applyAgentChatOperation,
            emptyAgentChatSnapshot('terminal-1'),
        );
        expect(snapshot.truncated).toBe(false);
        expect(snapshot.items).toHaveLength(1);
    });
});

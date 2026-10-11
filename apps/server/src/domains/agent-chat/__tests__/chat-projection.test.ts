import type { AgentChatPatchOperation } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { stampNewItems } from '../chat-projection';

const NOW = 1_700_000_000_000;

describe('stampNewItems', () => {
    it('dates an item the first time it reaches the projection, and only then', () => {
        const snapshot = applyAgentChatOperation(emptyAgentChatSnapshot('terminal-1'), {
            op: 'upsertItem',
            item: { id: 'old', type: 'agentMessage', text: 'Hi', streaming: false, createdAt: 1 },
        });
        const operations: AgentChatPatchOperation[] = [
            {
                op: 'upsertItem',
                item: { id: 'old', type: 'agentMessage', text: 'Hi!', streaming: false },
            },
            { op: 'upsertItem', item: { id: 'new', type: 'userMessage', text: 'Go' } },
            { op: 'upsertItem', item: { id: 'new', type: 'userMessage', text: 'Go on' } },
        ];
        const stamped = stampNewItems(snapshot, operations, NOW);
        expect(
            stamped.map((operation) => operation.op === 'upsertItem' && operation.item.createdAt),
        ).toEqual([undefined, NOW, undefined]);
    });

    it('keeps a provider-recorded time and leaves a history replay undated', () => {
        const snapshot = emptyAgentChatSnapshot('terminal-1');
        const recorded: AgentChatPatchOperation[] = [
            { op: 'upsertItem', item: { id: 'a', type: 'userMessage', text: 'Hi', createdAt: 5 } },
        ];
        expect(stampNewItems(snapshot, recorded, NOW)).toBe(recorded);
        const replay: AgentChatPatchOperation[] = [
            { op: 'reset' },
            { op: 'upsertItem', item: { id: 'b', type: 'userMessage', text: 'Earlier' } },
        ];
        expect(stampNewItems(snapshot, replay, NOW)).toBe(replay);
    });
});

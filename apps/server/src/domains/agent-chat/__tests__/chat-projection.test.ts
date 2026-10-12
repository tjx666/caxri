import type { AgentChatItem, AgentChatPatchOperation } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { carryAnsweredNotices, stampNewItems } from '../chat-projection';

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

describe('carryAnsweredNotices', () => {
    const answered: AgentChatItem = {
        id: 'answer:request-1',
        turnId: 't1',
        type: 'notice',
        kind: 'answered',
        message: 'Color: Blue',
        createdAt: 7,
    };
    const ids = (operations: readonly AgentChatPatchOperation[]) =>
        operations.map((operation) =>
            operation.op === 'upsertItem' ? operation.item.id : operation.op,
        );

    it('puts the notice back after the item it followed when a replay rebuilds its turn', () => {
        const previous: AgentChatItem[] = [
            { id: 'u1', turnId: 't1', type: 'userMessage', text: 'ask me' },
            { id: 'tool1', turnId: 't1', type: 'agentMessage', text: 'Asking', streaming: false },
            answered,
            { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Blue.', streaming: false },
        ];
        const replay: AgentChatPatchOperation[] = [
            { op: 'reset' },
            { op: 'upsertItem', item: previous[0] },
            { op: 'upsertItem', item: previous[1] },
            { op: 'upsertItem', item: previous[3] },
            { op: 'state', state: { turns: [{ id: 't1', status: 'completed' }] } },
        ];
        const carried = carryAnsweredNotices(previous, replay);
        expect(ids(carried)).toEqual(['reset', 'u1', 'tool1', 'answer:request-1', 'a1', 'state']);
        expect(carried[3]).toEqual({ op: 'upsertItem', item: answered });
    });

    it("falls back to its turn's first item when the replay renamed the item it followed", () => {
        const previous: AgentChatItem[] = [
            { id: 'local-u1', turnId: 't1', type: 'userMessage', text: 'ask me' },
            answered,
        ];
        const replay: AgentChatPatchOperation[] = [
            { op: 'reset' },
            {
                op: 'upsertItem',
                item: { id: 'u1', turnId: 't1', type: 'userMessage', text: 'ask me' },
            },
            {
                op: 'upsertItem',
                item: {
                    id: 'a1',
                    turnId: 't1',
                    type: 'agentMessage',
                    text: 'Blue.',
                    streaming: false,
                },
            },
        ];
        expect(ids(carryAnsweredNotices(previous, replay))).toEqual([
            'reset',
            'u1',
            'answer:request-1',
            'a1',
        ]);
    });

    it('drops the notice of a turn the replay no longer holds and leaves live batches alone', () => {
        const replay: AgentChatPatchOperation[] = [
            { op: 'reset' },
            { op: 'upsertItem', item: { id: 'u2', turnId: 't2', type: 'userMessage', text: 'Hi' } },
        ];
        expect(carryAnsweredNotices([answered], replay)).toBe(replay);
        const live: AgentChatPatchOperation[] = [
            { op: 'upsertItem', item: { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Hi' } },
        ];
        expect(carryAnsweredNotices([answered], live)).toBe(live);
    });
});

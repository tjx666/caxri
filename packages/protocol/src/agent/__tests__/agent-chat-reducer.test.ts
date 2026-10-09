import { describe, expect, it } from 'vitest';

import type { AgentChatSnapshot } from '../agent-chat-contract';
import {
    agentChatPatchSchema,
    agentChatSnapshotSchema,
    MAX_AGENT_CHAT_ITEMS,
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_TEXT_LENGTH,
    MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH,
} from '../agent-chat-contract';
import {
    applyAgentChatOperation,
    applyAgentChatPatch,
    emptyAgentChatSnapshot,
} from '../agent-chat-reducer';

const empty = (): AgentChatSnapshot => emptyAgentChatSnapshot('terminal-1');

describe('Agent Chat reducer', () => {
    it('upserts by id, appends deltas, and keeps the result schema-valid', () => {
        let snapshot = applyAgentChatOperation(empty(), {
            op: 'upsertItem',
            item: { id: 'a', type: 'agentMessage', text: 'Hel', streaming: true },
        });
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'appendText',
            itemId: 'a',
            delta: 'lo',
        });
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'upsertItem',
            item: { id: 'a', type: 'agentMessage', text: 'Hello', streaming: false },
        });
        expect(snapshot.items).toEqual([
            { id: 'a', type: 'agentMessage', text: 'Hello', streaming: false },
        ]);
        expect(() => agentChatSnapshotSchema.parse(snapshot)).not.toThrow();
    });

    it('ignores a delta for an unknown item', () => {
        const snapshot = empty();
        expect(
            applyAgentChatOperation(snapshot, { op: 'appendText', itemId: 'x', delta: 'y' }),
        ).toBe(snapshot);
    });

    it('keeps the head of a message but the tail of command output', () => {
        let snapshot = applyAgentChatOperation(empty(), {
            op: 'upsertItem',
            item: {
                id: 'm',
                type: 'agentMessage',
                text: 'a'.repeat(MAX_AGENT_CHAT_TEXT_LENGTH),
                streaming: true,
            },
        });
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'appendText',
            itemId: 'm',
            delta: 'zzz',
        });
        expect(snapshot.items[0]).toMatchObject({ text: 'a'.repeat(MAX_AGENT_CHAT_TEXT_LENGTH) });
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'upsertItem',
            item: {
                id: 'c',
                type: 'command',
                command: 'ls',
                status: 'running',
                output: 'a'.repeat(MAX_AGENT_CHAT_OUTPUT_LENGTH),
            },
        });
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'appendText',
            itemId: 'c',
            delta: 'end',
        });
        const command = snapshot.items[1];
        if (command.type !== 'command') throw new Error('Expected a command item');
        expect(command.output.endsWith('end')).toBe(true);
        expect(command.output).toHaveLength(MAX_AGENT_CHAT_OUTPUT_LENGTH);
    });

    it('drops the oldest items past the item and aggregate text budgets', () => {
        let snapshot = empty();
        for (let index = 0; index <= MAX_AGENT_CHAT_ITEMS; index += 1)
            snapshot = applyAgentChatOperation(snapshot, {
                op: 'upsertItem',
                item: { id: `u${index}`, type: 'userMessage', text: 'x' },
            });
        expect(snapshot.items).toHaveLength(MAX_AGENT_CHAT_ITEMS);
        expect(snapshot.items[0]?.id).toBe('u1');
        expect(snapshot.truncated).toBe(true);

        let large = empty();
        const count = Math.ceil(MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH / MAX_AGENT_CHAT_TEXT_LENGTH) + 2;
        for (let index = 0; index < count; index += 1)
            large = applyAgentChatOperation(large, {
                op: 'upsertItem',
                item: {
                    id: `m${index}`,
                    type: 'userMessage',
                    text: 'y'.repeat(MAX_AGENT_CHAT_TEXT_LENGTH),
                },
            });
        const total = large.items.reduce(
            (sum, item) => sum + (item.type === 'userMessage' ? item.text.length : 0),
            0,
        );
        expect(total).toBeLessThanOrEqual(MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH);
        expect(large.truncated).toBe(true);
    });

    it('clears optional state with null and resets everything but the revision', () => {
        let snapshot: AgentChatSnapshot = { ...empty(), revision: 4 };
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'state',
            state: { status: 'ready', activeTurnId: 't1', model: 'm' },
        });
        expect(snapshot).toMatchObject({ status: 'ready', activeTurnId: 't1', model: 'm' });
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'state',
            state: { activeTurnId: null },
        });
        expect('activeTurnId' in snapshot).toBe(false);
        expect(snapshot.model).toBe('m');
        snapshot = applyAgentChatOperation(snapshot, { op: 'reset' });
        expect(snapshot).toEqual({ ...empty(), revision: 4 });
    });

    it('applies a patch only on its base revision', () => {
        const patch = agentChatPatchSchema.parse({
            terminalId: 'terminal-1',
            baseRevision: 0,
            revision: 1,
            operations: [{ op: 'state', state: { status: 'starting' } }],
        });
        expect(applyAgentChatPatch(empty(), patch)).toMatchObject({
            revision: 1,
            status: 'starting',
        });
        expect(applyAgentChatPatch({ ...empty(), revision: 3 }, patch)).toBeUndefined();
    });
});

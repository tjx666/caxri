import { describe, expect, it } from 'vitest';

import type { AgentChatSnapshot } from '../agent-chat-contract';
import { agentChatPatchSchema, agentChatSnapshotSchema } from '../agent-chat-contract';
import {
    MAX_AGENT_CHAT_ITEMS,
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_TASK_ITEMS,
    MAX_AGENT_CHAT_TEXT_LENGTH,
    MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH,
} from '../agent-chat-limits';
import {
    applyAgentChatOperation,
    applyAgentChatPatch,
    applyAgentChatTaskOperation,
    applyAgentChatTaskPatch,
    emptyAgentChatSnapshot,
    emptyAgentChatTaskSnapshot,
} from '../agent-chat-reducer';
import { agentChatTaskSnapshotSchema } from '../agent-chat-task-contract';

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

    it('settles a retry notice only on progress after it, not on a tool that started before the outage', () => {
        let snapshot = applyAgentChatOperation(empty(), {
            op: 'upsertItem',
            item: {
                id: 'tool',
                turnId: 'turn-1',
                type: 'command',
                command: 'sleep 60',
                status: 'running',
                output: '',
            },
        });
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'upsertItem',
            item: {
                id: 'turn-1:retry',
                turnId: 'turn-1',
                type: 'notice',
                kind: 'retrying',
                retry: { cause: 'connection', attempt: 1 },
            },
        });
        const retry = () => snapshot.items.find((item) => item.id === 'turn-1:retry');
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'appendText',
            itemId: 'tool',
            delta: 'still running',
        });
        expect(retry()).not.toHaveProperty('retry.resolved');
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'upsertItem',
            item: {
                id: 'reply',
                turnId: 'turn-1',
                type: 'agentMessage',
                text: 'Back',
                streaming: true,
            },
        });
        expect(retry()).toMatchObject({ retry: { resolved: true } });
    });

    it('keeps the time an item began across later upserts that omit it', () => {
        let snapshot = applyAgentChatOperation(empty(), {
            op: 'upsertItem',
            item: { id: 'a', type: 'agentMessage', text: '', streaming: true, createdAt: 100 },
        });
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'upsertItem',
            item: { id: 'a', type: 'agentMessage', text: 'Done', streaming: false },
        });
        expect(snapshot.items).toEqual([
            { id: 'a', type: 'agentMessage', text: 'Done', streaming: false, createdAt: 100 },
        ]);
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'upsertItem',
            item: { id: 'a', type: 'agentMessage', text: 'Done', streaming: false, createdAt: 200 },
        });
        expect(snapshot.items[0]?.createdAt).toBe(200);
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

    it('holds the aggregate budget while a reply streams', () => {
        let snapshot = empty();
        const count = Math.floor(MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH / MAX_AGENT_CHAT_TEXT_LENGTH);
        for (let index = 0; index < count; index += 1)
            snapshot = applyAgentChatOperation(snapshot, {
                op: 'upsertItem',
                item: {
                    id: `m${index}`,
                    type: 'userMessage',
                    text: 'y'.repeat(MAX_AGENT_CHAT_TEXT_LENGTH),
                },
            });
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'upsertItem',
            item: { id: 'live', type: 'agentMessage', text: '', streaming: true },
        });
        expect(snapshot.truncated).toBe(false);
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'appendText',
            itemId: 'live',
            delta: 'z'.repeat(1024),
        });
        expect(snapshot.items[0]?.id).toBe('m1');
        expect(snapshot.items.at(-1)?.id).toBe('live');
        expect(snapshot.truncated).toBe(true);
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

describe('Agent Chat reducer: tasks, queue, and operation state', () => {
    it('keeps the follow-up queue across a conversation reset, but not the tasks', () => {
        let snapshot = applyAgentChatOperation(empty(), {
            op: 'state',
            state: {
                operation: 'compacting',
                tasks: [
                    {
                        id: 'task-1',
                        kind: 'shell',
                        title: 'npm test',
                        status: 'running',
                        isBackground: true,
                        canStop: true,
                    },
                ],
                queue: [{ id: 'q-1', text: 'next' }],
                queuePaused: true,
                queuePauseReason: 'sendFailed',
            },
        });
        expect(agentChatSnapshotSchema.parse(snapshot)).toMatchObject({
            operation: 'compacting',
            queuePaused: true,
        });
        snapshot = applyAgentChatOperation(snapshot, { op: 'state', state: { operation: null } });
        expect(snapshot).not.toHaveProperty('operation');
        snapshot = applyAgentChatOperation(snapshot, { op: 'reset' });
        expect(snapshot.queue).toEqual([{ id: 'q-1', text: 'next' }]);
        expect(snapshot.queuePaused).toBe(true);
        expect(snapshot.queuePauseReason).toBe('sendFailed');
        expect(snapshot.tasks).toBeUndefined();
        snapshot = applyAgentChatOperation(snapshot, {
            op: 'state',
            state: { queuePaused: false, queuePauseReason: null },
        });
        expect(snapshot).not.toHaveProperty('queuePauseReason');
    });

    it('keeps the models a provider offers across a conversation reset', () => {
        const models = [{ id: 'opus', displayName: 'Opus', efforts: ['high'] }];
        let snapshot = applyAgentChatOperation(empty(), {
            op: 'state',
            state: { models, usage: { totalTokens: 10, contextWindow: 100 } },
        });
        snapshot = applyAgentChatOperation(snapshot, { op: 'reset' });
        expect(snapshot.models).toEqual(models);
        expect(snapshot.usage).toBeUndefined();
    });

    it('keeps the permission a provider runs with across a conversation reset', () => {
        // A resumed Claude Code reports its level before its history replay resets the Chat, and reports it only once.
        let snapshot = applyAgentChatOperation(empty(), {
            op: 'state',
            state: { permissionMode: 'fullAccess', planMode: false },
        });
        snapshot = applyAgentChatOperation(snapshot, { op: 'reset' });
        expect(snapshot.permissionMode).toBe('fullAccess');
        expect(snapshot.planMode).toBe(false);
    });
});

describe('Agent Chat task reducer', () => {
    const emptyTask = () => emptyAgentChatTaskSnapshot('terminal-1', 'task-1');

    it('streams items and keeps the tail of shell output', () => {
        let snapshot = applyAgentChatTaskOperation(emptyTask(), {
            op: 'upsertItem',
            item: { id: 'a', type: 'agentMessage', text: 'Hel', streaming: true },
        });
        snapshot = applyAgentChatTaskOperation(snapshot, {
            op: 'appendText',
            itemId: 'a',
            delta: 'lo',
        });
        expect(snapshot.items).toEqual([
            { id: 'a', type: 'agentMessage', text: 'Hello', streaming: true },
        ]);
        snapshot = applyAgentChatTaskOperation(snapshot, {
            op: 'appendOutput',
            delta: 'x'.repeat(MAX_AGENT_CHAT_OUTPUT_LENGTH),
        });
        snapshot = applyAgentChatTaskOperation(snapshot, { op: 'appendOutput', delta: 'end' });
        expect(snapshot.output).toHaveLength(MAX_AGENT_CHAT_OUTPUT_LENGTH);
        expect(snapshot.output?.endsWith('end')).toBe(true);
        snapshot = applyAgentChatTaskOperation(snapshot, {
            op: 'state',
            state: { isOutputCapped: true },
        });
        expect(agentChatTaskSnapshotSchema.parse(snapshot).isOutputCapped).toBe(true);
    });

    it('evicts its own oldest items past the task budget and marks it truncated', () => {
        let snapshot = emptyTask();
        for (let index = 0; index <= MAX_AGENT_CHAT_TASK_ITEMS; index += 1)
            snapshot = applyAgentChatTaskOperation(snapshot, {
                op: 'upsertItem',
                item: { id: `m${index}`, type: 'agentMessage', text: 'hi', streaming: false },
            });
        expect(snapshot.items).toHaveLength(MAX_AGENT_CHAT_TASK_ITEMS);
        expect(snapshot.items[0]?.id).toBe('m1');
        expect(snapshot.truncated).toBe(true);
    });

    it('applies only a patch that continues the cached revision', () => {
        const patch = {
            baseRevision: 0,
            revision: 1,
            operations: [{ op: 'appendOutput' as const, delta: 'ok' }],
        };
        expect(applyAgentChatTaskPatch(emptyTask(), patch)).toMatchObject({
            revision: 1,
            output: 'ok',
        });
        expect(applyAgentChatTaskPatch({ ...emptyTask(), revision: 2 }, patch)).toBeUndefined();
    });
});

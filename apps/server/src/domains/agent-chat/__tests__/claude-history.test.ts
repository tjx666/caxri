import { describe, expect, it } from 'vitest';

import { claudeHistoryOperations } from '../claude-history';

function jsonl(records: unknown[]): string {
    return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('Claude transcript history', () => {
    it('dates each message by the transcript record that began it', () => {
        const operations = claudeHistoryOperations(
            jsonl([
                {
                    type: 'user',
                    uuid: 'u1',
                    timestamp: '2026-10-11T09:59:00.000Z',
                    message: { role: 'user', content: 'hello' },
                },
                {
                    type: 'assistant',
                    uuid: 'a1',
                    timestamp: '2026-10-11T10:00:00.000Z',
                    message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }] },
                },
                {
                    type: 'assistant',
                    uuid: 'a2',
                    timestamp: 'not a time',
                    message: { id: 'm2', content: [{ type: 'text', text: 'Again' }] },
                },
            ]),
            false,
        );
        const items = operations.flatMap((operation) =>
            operation.op === 'upsertItem' ? [operation.item] : [],
        );
        expect(items.map((item) => [item.type, item.createdAt])).toEqual([
            ['userMessage', Date.parse('2026-10-11T09:59:00.000Z')],
            ['agentMessage', Date.parse('2026-10-11T10:00:00.000Z')],
            ['agentMessage', undefined],
        ]);
    });

    it('restores how messages were delivered and skips queued notifications and peer messages', () => {
        const queuedUuid = 'a3c1e2f0-1b2c-8c01-9d4e-0123456789ab';
        const operations = claudeHistoryOperations(
            jsonl([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'slow please' } },
                {
                    type: 'attachment',
                    uuid: 'att1',
                    timestamp: '2026-10-11T10:00:00.000Z',
                    attachment: {
                        type: 'queued_command',
                        source_uuid: 'steer-1',
                        prompt: 'and then',
                        commandMode: 'prompt',
                    },
                },
                {
                    type: 'attachment',
                    attachment: {
                        type: 'queued_command',
                        source_uuid: 'notice-1',
                        prompt: '<task-notification>done</task-notification>',
                        commandMode: 'task-notification',
                        origin: { kind: 'task-notification' },
                    },
                },
                {
                    type: 'attachment',
                    attachment: {
                        type: 'queued_command',
                        source_uuid: 'peer-1',
                        prompt: 'a message from another Agent',
                        commandMode: 'prompt',
                        origin: { kind: 'peer' },
                    },
                },
                {
                    type: 'queue-operation',
                    operation: 'remove',
                    reason: 'absorbed_mid_turn',
                    commandUuid: 'steer-1',
                },
                {
                    type: 'assistant',
                    uuid: 'a1',
                    message: { id: 'm1', content: [{ type: 'text', text: 'Done' }] },
                },
                { type: 'user', uuid: queuedUuid, message: { role: 'user', content: 'next one' } },
            ]),
            false,
        );
        const items = operations.flatMap((operation) =>
            operation.op === 'upsertItem' ? [operation.item] : [],
        );
        expect(
            items.map((item) => [
                item.type,
                item.turnId,
                item.type === 'userMessage' ? item.delivery : undefined,
            ]),
        ).toEqual([
            ['userMessage', 'u1', undefined],
            ['userMessage', 'u1', 'steered'],
            ['agentMessage', 'u1', undefined],
            ['userMessage', queuedUuid, 'queued'],
        ]);
        expect(items[1]).toMatchObject({
            id: 'steer-1',
            text: 'and then',
            createdAt: Date.parse('2026-10-11T10:00:00.000Z'),
        });
    });

    it('rebuilds finished turns from visible records and skips sidechains and harness records', () => {
        const operations = claudeHistoryOperations(
            jsonl([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
                {
                    type: 'user',
                    uuid: 'meta',
                    isMeta: true,
                    message: { role: 'user', content: 'caveat' },
                },
                {
                    type: 'assistant',
                    uuid: 'a1',
                    message: {
                        id: 'm1',
                        content: [
                            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
                        ],
                    },
                },
                {
                    type: 'user',
                    uuid: 'r1',
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.ts' }],
                    },
                },
                {
                    type: 'assistant',
                    uuid: 'side',
                    isSidechain: true,
                    message: { id: 'm9', content: [{ type: 'text', text: 'subagent' }] },
                },
                {
                    type: 'assistant',
                    uuid: 'a2',
                    message: { id: 'm2', content: [{ type: 'text', text: 'Done.' }] },
                },
                { type: 'system', subtype: 'turn_duration', durationMs: 1234 },
                'not json',
            ]),
            false,
        );
        expect(operations[0]).toEqual({ op: 'reset' });
        const items = operations.flatMap((operation) =>
            operation.op === 'upsertItem' ? [operation.item] : [],
        );
        expect(items).toEqual([
            { id: 'u1', turnId: 'u1', type: 'userMessage', text: 'hello' },
            {
                id: 't1',
                turnId: 'u1',
                type: 'command',
                command: 'ls',
                status: 'completed',
                output: 'a.ts',
                exitCode: 0,
            },
            {
                id: 'm2:text:0',
                turnId: 'u1',
                type: 'agentMessage',
                text: 'Done.',
                streaming: false,
            },
        ]);
        expect(operations.at(-1)).toEqual({
            op: 'state',
            state: {
                turns: [{ id: 'u1', status: 'completed', durationMs: 1234 }],
                activeTurnId: null,
            },
        });
    });

    it('marks a cut-off transcript as truncated', () => {
        expect(claudeHistoryOperations('', true).at(-1)).toMatchObject({
            state: { truncated: true },
        });
    });
});

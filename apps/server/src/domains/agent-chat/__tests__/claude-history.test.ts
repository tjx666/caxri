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

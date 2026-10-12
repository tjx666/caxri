import { describe, expect, it } from 'vitest';

import { claudeHistoryOperations, claudeRewindPoint } from '../claude-history';
import { CLAUDE_DECLINED_MESSAGE } from '../claude-tool-results';

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

    it('restores a tool call the user declined as declined, as the live Chat showed it', () => {
        const operations = claudeHistoryOperations(
            jsonl([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'approve' } },
                {
                    type: 'assistant',
                    uuid: 'a1',
                    message: {
                        id: 'm1',
                        content: [
                            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
                            { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pwd' } },
                        ],
                    },
                },
                {
                    type: 'user',
                    uuid: 'r1',
                    message: {
                        role: 'user',
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: 't1',
                                content: CLAUDE_DECLINED_MESSAGE,
                                is_error: true,
                            },
                            {
                                type: 'tool_result',
                                tool_use_id: 't2',
                                content: 'Exit code 1\nno such directory',
                                is_error: true,
                            },
                        ],
                    },
                },
            ]),
            false,
        );
        const statuses = operations.flatMap((operation) =>
            operation.op === 'upsertItem' && operation.item.type === 'command'
                ? [[operation.item.id, operation.item.status]]
                : [],
        );
        expect(statuses).toEqual([
            ['t1', 'declined'],
            ['t2', 'failed'],
        ]);
    });

    it('marks a cut-off transcript as truncated', () => {
        expect(claudeHistoryOperations('', true).at(-1)).toMatchObject({
            state: { truncated: true },
        });
    });
});

function prompt(uuid: string, parentUuid: string | null, text: string) {
    return { type: 'user', uuid, parentUuid, message: { role: 'user', content: text } };
}

function reply(uuid: string, parentUuid: string, text: string, toolUse?: string) {
    return {
        type: 'assistant',
        uuid,
        parentUuid,
        message: {
            id: `m-${uuid}`,
            content: [
                toolUse
                    ? { type: 'tool_use', id: toolUse, name: 'Bash', input: { command: 'ls' } }
                    : { type: 'text', text },
            ],
        },
    };
}

function toolResult(uuid: string, parentUuid: string, toolUseId: string) {
    return {
        type: 'user',
        uuid,
        parentUuid,
        message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
        },
    };
}

function visibleTexts(transcript: string, resumeAt?: string): string[] {
    return claudeHistoryOperations(transcript, false, resumeAt).flatMap((operation) =>
        operation.op === 'upsertItem' && 'text' in operation.item ? [operation.item.text] : [],
    );
}

describe('Claude transcript rewinds', () => {
    // u2 was rewound: the conversation was resumed at a1 and continued with u2b.
    const rewound = jsonl([
        prompt('u1', null, 'first'),
        reply('a1', 'u1', 'one'),
        prompt('u2', 'a1', 'second'),
        reply('a2', 'u2', 'two'),
        prompt('u2b', 'a1', 'second again'),
        reply('a2b', 'u2b', 'two again'),
    ]);

    it('shows only the branch the conversation continued on', () => {
        expect(visibleTexts(rewound)).toEqual(['first', 'one', 'second again', 'two again']);
    });

    it('ends the history at the resume point before anything new was written', () => {
        expect(visibleTexts(rewound, 'a1')).toEqual(['first', 'one']);
    });

    it('keeps sibling tool results of parallel tool calls', () => {
        const parallel = jsonl([
            prompt('u1', null, 'run both'),
            reply('t1', 'u1', '', 'tool-1'),
            reply('t2', 't1', '', 'tool-2'),
            toolResult('r1', 't1', 'tool-1'),
            toolResult('r2', 't2', 'tool-2'),
            reply('a1', 'r2', 'both ran'),
        ]);
        const items = claudeHistoryOperations(parallel, false).flatMap((operation) =>
            operation.op === 'upsertItem' ? [operation.item] : [],
        );
        expect(items.filter((item) => item.type === 'command')).toHaveLength(2);
        expect(items.at(-1)).toMatchObject({ text: 'both ran' });
    });

    it('resumes at the record right before a message, or fresh for the first one', () => {
        expect(claudeRewindPoint(rewound, 'u2b')).toEqual({ kind: 'resumeAt', at: 'a1' });
        expect(claudeRewindPoint(rewound, 'u1')).toEqual({ kind: 'fresh' });
        expect(claudeRewindPoint(rewound, 'missing')).toBeUndefined();
        // The tail no longer holds the message's parent.
        const orphan = jsonl([prompt('u9', 'gone', 'late')]);
        expect(claudeRewindPoint(orphan, 'u9')).toBeUndefined();
    });
});

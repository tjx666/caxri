import { describe, expect, it } from 'vitest';

import { claudeHistoryOperations } from '../history/claude-history';

function jsonl(records: unknown[]): string {
    return records.map((record) => JSON.stringify(record)).join('\n');
}

const failure = (uuid: string, error: string, text: string) => ({
    type: 'assistant',
    uuid,
    parentUuid: 'p',
    isApiErrorMessage: true,
    error,
    message: { id: uuid, model: '<synthetic>', content: [{ type: 'text', text }] },
});

describe('Claude transcript history failures', () => {
    it('replays Claude Code’s synthetic failure replies as error notices that fail their turn', () => {
        const operations = claudeHistoryOperations(
            jsonl([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
                failure('a1', 'rate_limit', "You've hit your weekly limit · resets 2pm"),
                // A background task woke the Agent with no new prompt after that failure, and it answered.
                {
                    type: 'assistant',
                    uuid: 'a2',
                    parentUuid: 'a1',
                    message: { id: 'a2', content: [{ type: 'text', text: 'Task finished.' }] },
                },
                { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
                failure('a3', 'rate_limit', "You've hit your weekly limit · resets 2pm"),
                failure('a4', 'server_error', 'API Error: Connection dropped (ECONNRESET).'),
            ]),
            false,
        );
        const items = operations.flatMap((operation) =>
            operation.op === 'upsertItem' ? [operation.item] : [],
        );
        expect(items.flatMap((item) => (item.type === 'agentMessage' ? [item.text] : []))).toEqual([
            'Task finished.',
        ]);
        expect(
            items.flatMap((item) =>
                item.type === 'notice' ? [[item.turnId, item.kind, item.message]] : [],
            ),
        ).toEqual([
            ['u1', 'error', "You've hit your weekly limit · resets 2pm"],
            ['u2', 'error', "You've hit your weekly limit · resets 2pm"],
            ['u2', 'error', 'API Error: Connection dropped (ECONNRESET).'],
        ]);
        const state = operations.find((operation) => operation.op === 'state');
        expect(
            state?.op === 'state' && state.state.turns?.map((turn) => [turn.id, turn.status]),
        ).toEqual([
            ['u1', 'completed'],
            ['u2', 'failed'],
        ]);
    });
});

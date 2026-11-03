import type { AgentChatItem, AgentChatPatchOperation } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import { ChatProjection } from '../../chat-projection';
import type { CommandDelegationSource } from '../command-delegations';
import { CommandDelegationStamper } from '../command-delegations';

const ID_A = `dispatch-${'a'.repeat(64)}`;
const ID_B = `dispatch-${'b'.repeat(64)}`;
const ID_FOREIGN = `dispatch-${'c'.repeat(64)}`;
const UUID_ID = '0123abcd-0123-4abc-8def-0123456789ab';

type Command = Extract<AgentChatItem, { type: 'command' }>;

const command = (id: string, output: string, patch: Partial<Command> = {}): Command => ({
    id,
    type: 'command',
    command: 'caxri agent delegate create',
    status: 'completed',
    output,
    turnId: 'turn-1',
    ...patch,
});
const upsert = (item: AgentChatItem): AgentChatPatchOperation => ({ op: 'upsertItem', item });

function source(
    tasks: Record<string, { sessionId: string; turnId?: string }>,
    byTurn: Record<string, string[]> = {},
): CommandDelegationSource {
    return {
        owned: (delegationId) => tasks[delegationId],
        forTurn: (turnId) =>
            (byTurn[turnId] ?? []).map((delegationId) => ({
                delegationId,
                sessionId: tasks[delegationId].sessionId,
            })),
    };
}

const stampedItem = (operations: readonly AgentChatPatchOperation[], index = 0) => {
    const operation = operations[index];
    return operation.op === 'upsertItem' ? operation.item : undefined;
};

describe('CommandDelegationStamper', () => {
    const tasks = {
        [ID_A]: { sessionId: 'child-a', turnId: 'turn-1' },
        [ID_B]: { sessionId: 'child-b', turnId: 'turn-1' },
        [UUID_ID]: { sessionId: 'child-u', turnId: 'turn-1' },
    };

    it.each([
        ['JSON', `{"delegationId":"${ID_A}","status":"requested"}`],
        ['quiet', `${ID_A}\n`],
        ['human lines', `delegationId: ${ID_A}\nstatus: requested`],
    ])('marks the command whose %s output names an owned task', (_name, output) => {
        const stamper = new CommandDelegationStamper(source(tasks));

        const [stamped] = stamper.stamp([upsert(command('c1', output))]);

        expect(stampedItem([stamped])).toMatchObject({
            delegations: [{ delegationId: ID_A, sessionId: 'child-a' }],
        });
    });

    it('marks several tasks of one command and ignores an ID this Terminal did not create', () => {
        const stamper = new CommandDelegationStamper(source(tasks));

        const stamped = stamper.stamp([
            upsert(command('c1', `${ID_A} ${ID_FOREIGN} ${ID_B} ${UUID_ID}`)),
        ]);

        expect(stampedItem(stamped)).toMatchObject({
            delegations: [
                { delegationId: ID_A, sessionId: 'child-a' },
                { delegationId: ID_B, sessionId: 'child-b' },
                { delegationId: UUID_ID, sessionId: 'child-u' },
            ],
        });
    });

    it('does not mark a later wait or result that prints an already recorded ID as a second record', () => {
        const stamper = new CommandDelegationStamper(source(tasks));

        stamper.stamp([upsert(command('create', ID_A))]);
        const later = stamper.stamp([upsert(command('wait', `{"id":"${ID_A}"}`))]);

        expect(stampedItem(later)).not.toHaveProperty('delegations');
    });

    it('ignores a live command of another turn that prints the ID', () => {
        const stamper = new CommandDelegationStamper(source(tasks));

        const stamped = stamper.stamp([upsert(command('later', ID_A, { turnId: 'turn-2' }))]);

        expect(stampedItem(stamped)).not.toHaveProperty('delegations');
    });

    it('keeps the mark when the provider upserts the item again without it', () => {
        const stamper = new CommandDelegationStamper(source(tasks));

        stamper.stamp([upsert(command('c1', ID_A))]);
        const again = stamper.stamp([upsert(command('c1', `${ID_A}\nmore output`))]);

        expect(stampedItem(again)).toMatchObject({
            delegations: [{ delegationId: ID_A, sessionId: 'child-a' }],
        });
    });

    it('attaches a task recorded for the turn but named in no output to the newest settled command', () => {
        const stamper = new CommandDelegationStamper(source(tasks, { 'turn-1': [ID_A] }));

        const running = stamper.stamp([upsert(command('create', '', { status: 'running' }))]);
        const settled = stamper.stamp([upsert(command('create', 'redirected to a file'))]);

        expect(stampedItem(running)).not.toHaveProperty('delegations');
        expect(stampedItem(settled)).toMatchObject({
            delegations: [{ delegationId: ID_A, sessionId: 'child-a' }],
        });
    });

    it('does not attach the turn fallback to an older command', () => {
        const stamper = new CommandDelegationStamper(source(tasks, { 'turn-1': [ID_A] }));

        stamper.stamp([upsert(command('first', '', { status: 'running' }))]);
        stamper.stamp([upsert(command('second', '', { status: 'running' }))]);
        const older = stamper.stamp([upsert(command('first', 'done'))]);

        expect(stampedItem(older)).not.toHaveProperty('delegations');
    });

    it('attaches the turn fallback to the last command of a replayed turn, not its first', () => {
        const stamper = new CommandDelegationStamper(source(tasks, { 'turn-1': [ID_A] }));

        const replayed = stamper.stamp([
            { op: 'reset' },
            upsert(command('echo', 'preparing')),
            upsert(command('create', '')),
        ]);

        expect(stampedItem(replayed, 1)).not.toHaveProperty('delegations');
        expect(stampedItem(replayed, 2)).toMatchObject({
            delegations: [{ delegationId: ID_A, sessionId: 'child-a' }],
        });
    });

    it('marks again after a history replay, whatever turn IDs the replay carries', () => {
        const stamper = new CommandDelegationStamper(source(tasks));
        stamper.stamp([upsert(command('c1', ID_A))]);

        const replayed = stamper.stamp([
            { op: 'reset' },
            upsert(command('c1', ID_A, { turnId: 'replayed-turn' })),
        ]);

        expect(stampedItem(replayed, 1)).toMatchObject({
            delegations: [{ delegationId: ID_A, sessionId: 'child-a' }],
        });
    });

    it('leaves operations without a delegating command untouched', () => {
        const stamper = new CommandDelegationStamper(source(tasks));
        const operations = [upsert(command('c1', 'ls output')), { op: 'reset' as const }];

        expect(stamper.stamp(operations)).toBe(operations);
    });
});

describe('ChatProjection command delegations', () => {
    it('puts the mark on the projected item, live and after a replay', () => {
        const chat = new ChatProjection({
            terminalId: 'terminal-1',
            revision: 0,
            taskRevisionFloors: new Map(),
            logger: { write: () => {} } as unknown as StructuredLogger,
            send: () => {},
            onChange: () => {},
            delegatedTask: () => ({}),
            commandDelegations: source({ [ID_A]: { sessionId: 'child-a' } }),
        });
        const find = () =>
            chat.snapshot.items.find((item) => item.id === 'c1' && item.type === 'command');

        chat.apply([upsert(command('c1', ID_A))]);
        expect(find()).toMatchObject({ delegations: [{ delegationId: ID_A }] });

        chat.apply([{ op: 'reset' }, upsert(command('c1', ID_A))]);
        expect(find()).toMatchObject({
            delegations: [{ delegationId: ID_A, sessionId: 'child-a' }],
        });
    });
});

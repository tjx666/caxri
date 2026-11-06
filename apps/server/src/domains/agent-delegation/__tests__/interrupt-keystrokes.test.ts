import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { takenOverSession } from './hand-back.fixture';

/**
 * Human input reaches `interruptTerminal` once per keystroke in any Terminal, so its steady state must not touch
 * SQLite: these tests count the model reads it would otherwise make.
 */
async function keystrokeProbe() {
    const f = await takenOverSession();
    const { agentDelegations } = f.database;
    const forTerminal = vi.spyOn(agentDelegations, 'forTerminal');
    const pendingGrants = vi.spyOn(
        agentDelegations.handBacks as unknown as {
            queryPendingForTerminal: (terminalId: string) => unknown;
        },
        'queryPendingForTerminal',
    );
    const reads = () => forTerminal.mock.calls.length + pendingGrants.mock.calls.length;
    const type = (terminalId: string, count: number) => {
        for (let index = 0; index < count; index += 1)
            f.service.interruptTerminal(terminalId, true);
    };
    const clone = (isMarked: boolean) => {
        const task = f.stored(f.id);
        return agentDelegations.insert({
            ...task,
            receipt: { ...task.receipt, delegationId: randomUUID(), status: 'completed' },
            hasHumanIntervention: isMarked || undefined,
            humanInterventionAt: isMarked ? 1 : undefined,
        });
    };
    return { ...f, agentDelegations, clone, reads, type };
}

describe('interruptTerminal on human input', () => {
    it('reads nothing for a Terminal that has no task', async () => {
        const f = await keystrokeProbe();
        f.type('plain-shell', 1);
        const warmed = f.reads();
        f.type('plain-shell', 200);
        expect(f.reads()).toBe(warmed);
    });

    it('reads nothing once every task of the Terminal carries the takeover mark', async () => {
        const f = await keystrokeProbe();
        for (let index = 0; index < 50; index += 1) f.clone(true);
        f.type(f.terminal.id, 1);
        const warmed = f.reads();
        f.type(f.terminal.id, 200);
        expect(f.reads()).toBe(warmed);
    });

    it('still marks a task delegated after the Terminal was known to need nothing', async () => {
        const f = await keystrokeProbe();
        f.type(f.terminal.id, 3);
        const fresh = f.clone(false);
        expect(f.agentDelegations.get(fresh.receipt.delegationId)?.hasHumanIntervention).not.toBe(
            true,
        );
        f.type(f.terminal.id, 1);
        expect(f.agentDelegations.get(fresh.receipt.delegationId)).toMatchObject({
            hasHumanIntervention: true,
            humanInterventionAt: expect.any(Number) as number,
        });
    });

    it('still invalidates a hand-back grant given after quiet keystrokes', async () => {
        const f = await keystrokeProbe();
        f.type(f.terminal.id, 3);
        const grant = f.service.handBacks.handBack(f.id);
        expect(grant.status).toBe('granted');
        f.type(f.terminal.id, 1);
        expect(f.grants().map((entry) => entry.state)).toEqual(['invalidated']);
    });
});

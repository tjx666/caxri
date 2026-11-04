import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { StoredAgentDelegation } from '../models/agent-delegations';
import { CaxriDatabase } from '../repository';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-notices-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const { session } = database.createSession(project.id, 'shell');
    const record: StoredAgentDelegation = {
        receipt: {
            delegationId: 'task-1',
            projectId: session.projectId,
            sessionId: session.id,
            provider: 'claude',
            status: 'completed',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
        },
        principal: { kind: 'human-cli', id: 'synthetic-owner' },
        input: {
            projectId: session.projectId,
            sessionId: session.id,
            provider: 'claude',
            prompt: 'Synthetic task',
        },
        fingerprint: 'synthetic-fingerprint',
        promptDigest: 'a'.repeat(64),
        frozenLaunch: { executable: 'claude', args: [] },
    };
    database.agentDelegations.insert(record);
    const notice = (id: string, now = 10) => ({
        id,
        delegationId: 'task-1',
        kind: 'settled' as const,
        callerTerminalId: 'caller',
        callerLaunchId: 'launch-1',
        now,
    });
    return { notices: database.agentDelegations.notices, database, notice };
}

describe('delegation notices', () => {
    it('stores an event once however often it is registered', async () => {
        const { notices, notice } = await fixture();

        expect(notices.register(notice('settled:task-1'))).toBe(true);
        expect(notices.register(notice('settled:task-1', 20))).toBe(false);

        expect(notices.get('settled:task-1')).toMatchObject({ state: 'pending', createdAt: 10 });
    });

    it('lets exactly one writer claim a pending notice', async () => {
        const { notices, notice } = await fixture();
        notices.register(notice('settled:task-1'));

        expect(notices.claim(['settled:task-1'], 'unknown', 11)).toEqual(['settled:task-1']);
        expect(notices.claim(['settled:task-1'], 'unknown', 12)).toEqual([]);
        expect(notices.pending()).toEqual([]);
        expect(notices.settle('settled:task-1', 'unknown', 'delivered', 13)).toBe(true);
        expect(notices.get('settled:task-1')?.state).toBe('delivered');
    });

    it('lists the pending notices of one caller launch only', async () => {
        const { notices, notice } = await fixture();
        notices.register(notice('settled:task-1'));
        notices.register({ ...notice('question:q1', 11), kind: 'question', subjectId: 'q1' });
        notices.register({ ...notice('settled:other'), callerLaunchId: 'launch-2' });

        expect(notices.pendingFor('caller', 'launch-1').map(({ id }) => id)).toEqual([
            'settled:task-1',
            'question:q1',
        ]);
        expect(notices.hasPendingFor('caller', 'launch-1')).toBe(true);
        expect(notices.hasPendingFor('caller', 'launch-3')).toBe(false);
    });

    it('discards only a pending notice, so its event can register again', async () => {
        const { notices, notice } = await fixture();
        notices.register(notice('settled:task-1'));

        expect(notices.discard('settled:task-1')).toBe(true);
        expect(notices.register(notice('settled:task-1'))).toBe(true);
        notices.claim(['settled:task-1'], 'unknown', 11);
        expect(notices.discard('settled:task-1')).toBe(false);
    });

    it('records that the caller read the outcome once, whatever the notice state', async () => {
        const { notices, notice } = await fixture();
        notices.register(notice('settled:task-1'));
        notices.claim(['settled:task-1'], 'skipped', 11);

        expect(notices.acknowledge('settled:task-1', 12)).toBe(true);
        expect(notices.acknowledge('settled:task-1', 13)).toBe(false);
        expect(notices.acknowledge('settled:missing', 13)).toBe(false);
        expect(notices.get('settled:task-1')?.acknowledgedAt).toBe(12);
    });

    it('is removed with its task', async () => {
        const { notices, database, notice } = await fixture();
        notices.register(notice('settled:task-1'));

        database.deleteSession(database.agentDelegations.get('task-1')!.receipt.sessionId);

        expect(notices.get('settled:task-1')).toBeUndefined();
    });

    it('rejects a kind outside the closed set', async () => {
        const { notices, notice } = await fixture();

        expect(() => notices.register({ ...notice('x:1'), kind: 'bogus' as never })).toThrow();
    });
});

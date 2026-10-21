import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { StoredAgentDelegation } from '../models/agent-delegations';
import { CaxriDatabase } from '../repository';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegations-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    const database = new CaxriDatabase(path);
    const { session } = database.createSession(database.createProject(directory).id, 'shell');
    const record: StoredAgentDelegation = {
        receipt: {
            delegationId: 'synthetic-delegation',
            projectId: session.projectId,
            sessionId: session.id,
            provider: 'claude',
            status: 'requested',
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
    return { database, path, record, session };
}

describe('Agent delegation persistence', () => {
    it('retains a private completed answer across database restart and excludes it from active tasks', async () => {
        const { database, path, record } = await fixture();
        database.agentDelegations.insert(record);
        expect(database.agentDelegations.active()).toHaveLength(1);
        const completed: StoredAgentDelegation = {
            ...record,
            receipt: { ...record.receipt, status: 'completed', revision: 2 },
            answer: {
                text: 'Synthetic answer',
                source: 'transcript',
                messageId: 'synthetic-message',
                truncated: false,
                byteLength: 16,
            },
        };
        database.agentDelegations.save(completed);
        database.close();
        const reopened = new CaxriDatabase(path);
        try {
            expect(reopened.agentDelegations.get(record.receipt.delegationId)).toEqual(completed);
            expect(reopened.agentDelegations.active()).toEqual([]);
        } finally {
            reopened.close();
        }
    });

    it('removes task metadata when its owning Session is deleted', async () => {
        const { database, record, session } = await fixture();
        try {
            database.agentDelegations.insert(record);
            database.deleteSession(session.id);
            expect(database.agentDelegations.get(record.receipt.delegationId)).toBeUndefined();
        } finally {
            database.close();
        }
    });

    it('prunes the oldest settled answer-less tasks at capacity and keeps answers and live tasks', async () => {
        const { database, record } = await fixture();
        try {
            const make = (id: string, status: 'failed' | 'completed' | 'running', at: number) =>
                ({
                    ...record,
                    receipt: { ...record.receipt, delegationId: id, status, updatedAt: at },
                    ...(status === 'completed' && {
                        answer: {
                            text: 'Synthetic answer',
                            source: 'transcript' as const,
                            messageId: 'm',
                            truncated: false,
                            byteLength: 16,
                        },
                    }),
                }) satisfies StoredAgentDelegation;
            database.agentDelegations.insert(make('answered', 'completed', 1));
            database.agentDelegations.insert(make('live', 'running', 2));
            database.agentDelegations.insert(make('settled-old', 'failed', 3));
            database.agentDelegations.insert(make('settled-new', 'failed', 4));
            for (let index = 0; index < 1024 - 4; index += 1)
                database.agentDelegations.insert(make(`filler-${index}`, 'running', 10 + index));

            const pruned: string[][] = [];
            database.agentDelegations.insert(make('admitted', 'running', 100), (ids) =>
                pruned.push(ids),
            );
            expect(pruned).toEqual([['settled-old']]);

            expect(database.agentDelegations.get('settled-old')).toBeUndefined();
            for (const id of ['answered', 'live', 'settled-new', 'admitted'])
                expect(database.agentDelegations.get(id)).toBeDefined();
        } finally {
            database.close();
        }
    });

    it('never prunes the task a resume continues', async () => {
        const { database, record } = await fixture();
        try {
            const settled = (id: string, at: number): StoredAgentDelegation => ({
                ...record,
                rootDelegationId: undefined,
                receipt: { ...record.receipt, delegationId: id, status: 'failed', updatedAt: at },
            });
            database.agentDelegations.insert(settled('resumed', 1));
            database.agentDelegations.insert(settled('other', 2));
            for (let index = 0; index < 1024 - 2; index += 1)
                database.agentDelegations.insert({
                    ...record,
                    receipt: { ...record.receipt, delegationId: `live-${index}`, updatedAt: 10 },
                });

            const pruned: string[][] = [];
            database.agentDelegations.insert(
                {
                    ...settled('resume', 100),
                    input: { ...record.input, resumeFrom: 'resumed' },
                    receipt: { ...record.receipt, delegationId: 'resume' },
                },
                (ids) => pruned.push(ids),
            );
            expect(pruned).toEqual([['other']]);
            expect(database.agentDelegations.get('resumed')).toBeDefined();
        } finally {
            database.close();
        }
    });

    it('refuses capacity when nothing is prunable', async () => {
        const { database, record } = await fixture();
        try {
            for (let index = 0; index < 1024; index += 1)
                database.agentDelegations.insert({
                    ...record,
                    receipt: { ...record.receipt, delegationId: `live-${index}` },
                });
            expect(() => database.agentDelegations.insert(record)).toThrow(
                expect.objectContaining({ code: 'CAPACITY' }),
            );
        } finally {
            database.close();
        }
    });
});

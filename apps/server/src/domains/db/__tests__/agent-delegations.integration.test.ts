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
});

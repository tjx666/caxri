import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION, schemaVersionForMigration } from '../migrations/manifest';
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
    it('backfills indexed Terminal ownership from the preceding schema without losing task data', async () => {
        const { database, path, record, session } = await fixture();
        const terminalId = database.listTerminals(session.id)[0].id;
        record.receipt.terminalId = terminalId;
        database.agentDelegations.insert(record);
        database.database.exec('DROP INDEX agent_delegations_terminal');
        database.database.exec('ALTER TABLE agent_delegations DROP COLUMN terminal_id');
        database.database.exec('ALTER TABLE terminals DROP COLUMN failure_detail');
        // Every column added after the pinned `user_version` below has to go too, or its own migration re-adds it on
        // top of a column the fresh install already created.
        database.database.exec('ALTER TABLE sessions DROP COLUMN pinned_at');
        database.database.exec('ALTER TABLE sessions DROP COLUMN pinned_order');
        database.database.exec('ALTER TABLE session_state DROP COLUMN revision');
        database.database.exec('ALTER TABLE projects DROP COLUMN hidden_at');
        database.database.exec('DROP TABLE mobile_agent_submit_receipts');
        database.database.pragma(
            `user_version = ${schemaVersionForMigration('0025_conscious_living_tribunal')}`,
        );
        database.close();
        const upgraded = new CaxriDatabase(path);
        try {
            expect(upgraded.agentDelegations.hasTerminal(terminalId)).toBe(true);
            expect(upgraded.agentDelegations.get(record.receipt.delegationId)).toEqual(record);
        } finally {
            upgraded.close();
        }
    });

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

    it('creates delegation storage without losing Session or Terminal records', async () => {
        const { database, path, record, session } = await fixture();
        const terminals = database.listTerminals(session.id);
        database.database.exec('DROP TABLE agent_delegations');
        database.database.exec('ALTER TABLE terminals DROP COLUMN failure_detail');
        // Every column added after the pinned `user_version` below has to go too, or its own migration re-adds it on
        // top of a column the fresh install already created.
        database.database.exec('ALTER TABLE sessions DROP COLUMN pinned_at');
        database.database.exec('ALTER TABLE sessions DROP COLUMN pinned_order');
        database.database.exec('ALTER TABLE session_state DROP COLUMN revision');
        database.database.exec('ALTER TABLE projects DROP COLUMN hidden_at');
        database.database.exec('DROP TABLE mobile_agent_submit_receipts');
        database.database.pragma(
            `user_version = ${schemaVersionForMigration('0024_session-naming-sync')}`,
        );
        database.close();
        const upgraded = new CaxriDatabase(path);
        try {
            expect(upgraded.getSession(session.id)?.projectId).toBe(session.projectId);
            expect(upgraded.listTerminals(session.id).map((terminal) => terminal.id)).toEqual(
                terminals.map((terminal) => terminal.id),
            );
            expect(upgraded.agentDelegations.insert(record)).toEqual(record);
            expect(upgraded.database.pragma('user_version', { simple: true })).toBe(
                CURRENT_SCHEMA_VERSION,
            );
        } finally {
            upgraded.close();
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

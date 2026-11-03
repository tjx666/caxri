import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { StoredAgentDelegation } from '../models/agent-delegations';
import { CaxriDatabase } from '../repository';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegations-retry-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(() => database.close());
    const { session } = database.createSession(database.createProject(directory).id, 'shell');
    const make = (
        id: string,
        status: 'failed' | 'running',
        updatedAt: number,
        links: { retryOf?: string; retriedAs?: string; retryScheduledFor?: number } = {},
        mode?: 'resume',
    ): StoredAgentDelegation => ({
        receipt: {
            delegationId: id,
            projectId: session.projectId,
            sessionId: session.id,
            provider: 'claude',
            status,
            revision: 1,
            createdAt: 1,
            updatedAt,
            ...links,
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
        ...(mode && { retryMode: mode }),
    });
    /**
     * Fills the table with live tasks until `stored` records exist in total.
     */
    const fillTo = (stored: number, alreadyStored: number) => {
        for (let index = 0; index < stored - alreadyStored; index += 1)
            database.agentDelegations.insert(make(`live-${index}`, 'running', 100 + index));
    };
    return { database, fillTo, make };
}

describe('Agent delegation pruning of retry chains', () => {
    it('keeps the failed task while its retry is unsettled', async () => {
        const { database, fillTo, make } = await fixture();
        database.agentDelegations.insert(make('failed', 'failed', 1, { retriedAs: 'successor' }));
        database.agentDelegations.insert(make('successor', 'running', 2, { retryOf: 'failed' }));
        database.agentDelegations.insert(make('other', 'failed', 3));
        fillTo(1024, 3);

        database.agentDelegations.insert(make('admitted', 'running', 500));

        expect(database.agentDelegations.get('other')).toBeUndefined();
        expect(database.agentDelegations.get('failed')).toBeDefined();
    });

    it('releases the failed task once its retry settled, and keeps the retry it links to', async () => {
        const { database, fillTo, make } = await fixture();
        database.agentDelegations.insert(make('failed', 'failed', 1, { retriedAs: 'successor' }));
        database.agentDelegations.insert(make('successor', 'failed', 2, { retryOf: 'failed' }));
        fillTo(1024, 2);

        database.agentDelegations.insert(make('admitted', 'running', 500));

        expect(database.agentDelegations.get('failed')).toBeUndefined();
        expect(database.agentDelegations.get('successor')).toBeDefined();
    });

    it('protects the failed task a retry being admitted points at', async () => {
        const { database, fillTo, make } = await fixture();
        database.agentDelegations.insert(make('failed', 'failed', 1, { retriedAs: 'retry' }));
        database.agentDelegations.insert(make('other', 'failed', 2));
        fillTo(1024, 2);

        database.agentDelegations.insert(make('retry', 'running', 500, { retryOf: 'failed' }));

        expect(database.agentDelegations.get('other')).toBeUndefined();
        expect(database.agentDelegations.get('failed')).toBeDefined();
    });

    it('never exhausts capacity on a full chain of settled retries', async () => {
        const { database, make } = await fixture();
        for (let index = 0; index < 1024; index += 1)
            database.agentDelegations.insert(
                make(`link-${index}`, 'failed', index + 1, {
                    ...(index > 0 && { retryOf: `link-${index - 1}` }),
                    ...(index < 1023 && { retriedAs: `link-${index + 1}` }),
                }),
            );

        expect(() =>
            database.agentDelegations.insert(make('admitted', 'running', 5000)),
        ).not.toThrow();
        expect(database.agentDelegations.get('link-0')).toBeUndefined();
        expect(database.agentDelegations.get('link-1')).toBeDefined();
    });
});

describe('Agent delegation scheduled retries', () => {
    it('keeps the failed task a pending schedule waits on, even at capacity', async () => {
        const { database, fillTo, make } = await fixture();
        database.agentDelegations.insert(
            make(
                'failed',
                'failed',
                1,
                { retriedAs: 'successor', retryScheduledFor: 9_000 },
                'resume',
            ),
        );
        database.agentDelegations.insert(make('other', 'failed', 2));
        fillTo(1024, 2);

        database.agentDelegations.insert(make('admitted', 'running', 500));

        expect(database.agentDelegations.get('other')).toBeUndefined();
        expect(database.agentDelegations.get('failed')).toBeDefined();
    });

    it('lists the pending schedules oldest first', async () => {
        const { database, make } = await fixture();
        database.agentDelegations.insert(
            make('late', 'failed', 1, { retriedAs: 'a', retryScheduledFor: 9_000 }, 'resume'),
        );
        database.agentDelegations.insert(
            make('early', 'failed', 2, { retriedAs: 'b', retryScheduledFor: 5_000 }, 'resume'),
        );
        database.agentDelegations.insert(make('plain', 'failed', 3, { retriedAs: 'c' }, 'resume'));

        expect(
            database.agentDelegations.scheduledRetries().map((r) => r.receipt.delegationId),
        ).toEqual(['early', 'late']);
    });

    it('rejects a pending time without its claim', async () => {
        const { database, make } = await fixture();

        expect(() =>
            database.agentDelegations.insert(
                make('no-claim', 'failed', 1, { retryScheduledFor: 9_000 }),
            ),
        ).toThrow();
        expect(() =>
            database.agentDelegations.insert(
                make('no-mode', 'failed', 1, { retriedAs: 'x', retryScheduledFor: 9_000 }),
            ),
        ).toThrow();
    });

    it('rejects a refusal outcome on a task that holds a claim', async () => {
        const { database, make } = await fixture();
        const record = make('failed', 'failed', 1, { retriedAs: 'x' }, 'resume');

        expect(() =>
            database.agentDelegations.insert({
                ...record,
                receipt: { ...record.receipt, retryScheduleOutcome: 'missed_window' },
            }),
        ).toThrow();
    });
});

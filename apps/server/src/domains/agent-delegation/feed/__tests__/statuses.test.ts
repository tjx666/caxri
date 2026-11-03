import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { delegatedFixture } from '../../__tests__/delegated-sessions.fixture';

describe('agent.delegation.statuses', () => {
    it('reports the exact task named, not the newest task of its Session', async () => {
        const f = await delegatedFixture();
        const first = await f.delegate();
        await f.finish(first, 'Summary: First finding.');
        f.state.clock += 1000;
        const secondId = randomUUID();
        const second = await f.service.create(secondId, f.authority, {
            projectId: f.project.id,
            sessionId: first.receipt.sessionId,
            provider: 'claude',
            prompt: 'Synthetic second task',
        });
        f.start({ id: secondId, terminalId: second.terminalId! });

        const statuses = await f.statuses([first.id, secondId]);

        expect(statuses).toEqual([
            {
                delegationId: first.id,
                sessionId: first.receipt.sessionId,
                provider: 'claude',
                status: 'completed',
                settledAt: expect.any(Number) as number,
            },
            {
                delegationId: secondId,
                sessionId: first.receipt.sessionId,
                provider: 'claude',
                status: 'running',
            },
        ]);
    });

    it('carries no answer or summary, omits unknown IDs, and claims nothing', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        await f.finish(task, 'Summary: Secret finding.');

        const statuses = await f.statuses([task.id, 'unknown-task', task.id]);

        expect(statuses).toHaveLength(1);
        expect(JSON.stringify(statuses)).not.toContain('Secret finding');
        expect(f.database.agentDelegations.get(task.id)?.collectedAt).toBeUndefined();
    });

    it('reports a failure with the time its limit resets', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        const record = f.database.agentDelegations.get(task.id)!;
        f.database.agentDelegations.save({
            ...record,
            receipt: {
                ...record.receipt,
                status: 'failed',
                failure: 'quota_exhausted',
                failureResetsAt: 99_000,
                settledAt: 5000,
            },
        });

        expect(await f.statuses([task.id])).toEqual([
            expect.objectContaining({
                status: 'failed',
                failure: 'quota_exhausted',
                failureResetsAt: 99_000,
                settledAt: 5000,
            }),
        ]);
    });

    it('links a retried task to its retry in both directions', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        const record = f.database.agentDelegations.get(task.id)!;
        f.database.agentDelegations.save({
            ...record,
            receipt: {
                ...record.receipt,
                status: 'failed',
                failure: 'provider_failed',
                settledAt: 5000,
                retriedAs: 'retry-1',
                retryOf: 'earlier-1',
            },
        });

        expect(await f.statuses([task.id])).toEqual([
            expect.objectContaining({ retriedAs: 'retry-1', retryOf: 'earlier-1' }),
        ]);
    });

    it('carries the links into the Delegated Sessions feed', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        const record = f.database.agentDelegations.get(task.id)!;
        f.database.agentDelegations.save({
            ...record,
            receipt: { ...record.receipt, status: 'failed', retriedAs: 'retry-1' },
        });

        expect(await f.sessions([f.callerSessionId])).toEqual([
            expect.objectContaining({ delegationId: task.id, retriedAs: 'retry-1' }),
        ]);
    });

    it('omits the links from a task that was never retried', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();

        const [status] = await f.statuses([task.id]);

        expect(status).not.toHaveProperty('retryOf');
        expect(status).not.toHaveProperty('retriedAs');
    });
});

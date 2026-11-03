import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { retryDelegationId } from '../retry-support';
import { fixture, reasonOf } from './retry.fixture';

describe('retry now: eligibility', () => {
    it.each([
        'caller_stopped',
        'human_input',
        'target_busy',
        'target_not_ready',
        'submission_unconfirmed',
    ] as const)('refuses the %s failure', async (failure) => {
        const { failedTask, service } = await fixture();
        const failed = await failedTask(failure);

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('not_retryable');
    });

    it('refuses interruptions and active tasks', async () => {
        const { database, failedTask, service, stored } = await fixture();
        const interrupted = await failedTask();
        const record = stored(interrupted.id);
        database.agentDelegations.save({
            ...record,
            receipt: { ...record.receipt, status: 'interrupted', failure: 'target_changed' },
        });
        expect(await reasonOf(service.retries.retry(interrupted.id, 'fresh'))).toBe(
            'not_retryable',
        );
        const running = await failedTask();
        const active = stored(running.id);
        database.agentDelegations.save({
            ...active,
            receipt: { ...active.receipt, status: 'running', failure: undefined },
        });
        expect(await reasonOf(service.retries.retry(running.id, 'fresh'))).toBe('not_retryable');
    });

    it('refuses a task the user took over', async () => {
        const { database, failedTask, service, stored } = await fixture();
        const failed = await failedTask();
        database.agentDelegations.save({ ...stored(failed.id), hasHumanIntervention: true });

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('human_input');
    });

    it('refuses a task that was already followed up', async () => {
        const { database, failedTask, service, stored } = await fixture();
        const failed = await failedTask();
        database.agentDelegations.save({ ...stored(failed.id), nextDelegationId: randomUUID() });

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('not_retryable');
    });

    it('refuses an unknown task and an external delegation client', async () => {
        const { database, failedTask, service, stored } = await fixture();
        await expect(service.retries.retry(randomUUID(), 'fresh')).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        const failed = await failedTask();
        const record = stored(failed.id);
        database.agentDelegations.save({
            ...record,
            principal: {
                kind: 'delegation-client',
                id: 'client',
                clientId: 'client',
                generation: 1,
                projectIds: [record.input.projectId],
                sessionId: record.input.sessionId,
                callerProvider: 'claude',
            },
        });

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('not_retryable');
    });

    it('refuses when the delegating Terminal is gone', async () => {
        const { callerTerminalId, database, failedTask, service } = await fixture();
        const failed = await failedTask();
        database.closeTerminal(callerTerminalId);

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('caller_gone');
        expect(await reasonOf(service.retries.retry(failed.id, 'resume'))).toBe('caller_gone');
    });

    it('refuses when the delegating Agent is a newer generation than the stored principal', async () => {
        const { failedTask, service, state, stored } = await fixture();
        const failed = await failedTask();
        state.generation = 2;

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('caller_gone');
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
    });

    it('refuses an Agent when no Endpoint generation can be proven', async () => {
        const { failedTask, service } = await fixture({ callerEndpoint: undefined });
        const failed = await failedTask();

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('caller_gone');
    });

    it('rechecks the delegating Agent after the last await before the record exists', async () => {
        const { database, failedTask, service, state, stored, verifyLaunch } = await fixture();
        const failed = await failedTask();
        verifyLaunch.mockImplementationOnce(() => {
            state.generation = 2;
            return Promise.resolve();
        });
        const sessionsBefore = database.listSessions().length;

        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('caller_gone');

        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
        expect(database.listSessions()).toHaveLength(sessionsBefore);
        expect(database.agentDelegations.get(retryDelegationId(failed.id))).toBeUndefined();
    });
});

describe('retry now: claim and options', () => {
    it('announces the claim so the feed refreshes', async () => {
        const { failedTask, receiptChanges, service } = await fixture();
        const failed = await failedTask();
        receiptChanges.mockClear();

        const { delegationId } = await service.retries.retry(failed.id, 'fresh');

        const claim = receiptChanges.mock.calls.find(
            ([receipt, previous]) =>
                receipt.delegationId === failed.id &&
                receipt.retriedAs === delegationId &&
                previous?.retriedAs === undefined,
        );
        expect(claim).toBeDefined();
    });

    it('releases a claim that names a task that was never stored when the Server starts', async () => {
        const { database, failedTask, service, stored } = await fixture();
        const failed = await failedTask();
        const record = stored(failed.id);
        database.agentDelegations.save({
            ...record,
            retryMode: 'fresh',
            receipt: { ...record.receipt, retriedAs: randomUUID() },
        });

        service.initialize();

        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
        expect(stored(failed.id).retryMode).toBeUndefined();
    });

    it('keeps a claim whose task exists when the Server starts', async () => {
        const { failedTask, service, stored } = await fixture();
        const failed = await failedTask();
        const { delegationId } = await service.retries.retry(failed.id, 'fresh');

        service.initialize();

        expect(stored(failed.id).receipt.retriedAs).toBe(delegationId);
    });

    it('lists both modes with the reason each is unavailable', async () => {
        const { failedTask, service, state } = await fixture();
        const failed = await failedTask();

        expect(await service.retries.options(failed.id)).toEqual({
            options: [
                { mode: 'resume', provider: 'claude', available: true },
                { mode: 'fresh', provider: 'claude', available: true },
            ],
            schedule: { available: false, unavailableReason: 'no_reset_time' },
            switchTargets: [],
        });

        state.childLaunch = 'another-launch';
        expect((await service.retries.options(failed.id)).options).toEqual([
            {
                mode: 'resume',
                provider: 'claude',
                available: false,
                unavailableReason: 'target_changed',
            },
            { mode: 'fresh', provider: 'claude', available: true },
        ]);

        await service.retries.retry(failed.id, 'fresh');
        expect(
            (await service.retries.options(failed.id)).options.map(
                (option) => option.unavailableReason,
            ),
        ).toEqual(['already_retried', 'already_retried']);
    });

    it('logs closed enums and IDs without the task text', async () => {
        const { failedTask, loggerWrite, service } = await fixture();
        const failed = await failedTask('quota_exhausted', 'Secret private prompt text');

        await service.retries.retry(failed.id, 'fresh');
        await reasonOf(service.retries.retry(failed.id, 'resume'));

        const retryLogs = loggerWrite.mock.calls.filter((call) =>
            String(call[1]).startsWith('agent_delegation.retry'),
        );
        expect(retryLogs.map((call) => [call[1], call[2]?.fields?.outcome])).toEqual(
            expect.arrayContaining([
                ['agent_delegation.retry_requested', 'started'],
                ['agent_delegation.retry_requested', 'refused'],
                ['agent_delegation.retry_notice', 'sent'],
            ]),
        );
        expect(JSON.stringify(loggerWrite.mock.calls)).not.toContain('Secret private prompt text');
    });
});

describe('retry now: notice to the delegating Agent', () => {
    it('writes one launch-pinned notice naming both tasks', async () => {
        const { callerTerminalId, failedTask, service, write } = await fixture();
        const failed = await failedTask();
        write.mockClear();

        const { delegationId } = await service.retries.retry(failed.id, 'fresh');
        await service.retries.retry(failed.id, 'fresh');

        const notices = write.mock.calls.filter(([terminalId]) => terminalId === callerTerminalId);
        expect(notices).toHaveLength(1);
        expect(notices[0][1]).toBe('caller-launch');
        expect(notices[0][2]).toContain(failed.id);
        expect(notices[0][2]).toContain(delegationId);
    });
});

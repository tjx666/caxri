import { describe, expect, it, vi } from 'vitest';

import { RETRY_SCHEDULE_MARGIN_MS, RETRY_SCHEDULE_MISSED_AFTER_MS } from '../schedule-time';
import { retryDelegationId } from '../support';
import { fixture, reasonOf } from './fixture';

const T0 = 1_000_000_000_000;
const RESET_IN_MS = 10 * 60_000;

async function scheduled(settings: Parameters<typeof fixture>[0] = {}) {
    const clock = { now: T0 };
    const base = await fixture({ now: () => clock.now, ...settings });
    const failTask = async () => {
        const failed = await base.failedTask();
        const record = base.stored(failed.id);
        base.database.agentDelegations.save({
            ...record,
            receipt: { ...record.receipt, failureResetsAt: T0 + RESET_IN_MS },
        });
        return failed;
    };
    const dueAt = T0 + RESET_IN_MS + RETRY_SCHEDULE_MARGIN_MS;
    return { ...base, clock, dueAt, failTask };
}

describe('scheduled retry: claim', () => {
    it('holds the claim and records the time with the margin, starting nothing', async () => {
        const { dueAt, failTask, receiptChanges, service, start, resume, stored } =
            await scheduled();
        const failed = await failTask();
        start.mockClear();

        const reply = await service.retries.retry(failed.id, 'resume', 'reset');

        expect(reply).toEqual({
            status: 'scheduled',
            delegationId: failed.id,
            scheduledFor: dueAt,
        });
        expect(stored(failed.id).receipt).toMatchObject({
            retriedAs: retryDelegationId(failed.id),
            retryScheduledFor: dueAt,
        });
        expect(stored(failed.id).retryMode).toBe('resume');
        expect(resume).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        expect(receiptChanges).toHaveBeenCalledWith(
            expect.objectContaining({ retryScheduledFor: dueAt }),
            expect.anything(),
        );
    });

    it('refuses to schedule without a known reset time', async () => {
        const { failedTask, service } = await scheduled();
        const failed = await failedTask();

        expect(await reasonOf(service.retries.retry(failed.id, 'resume', 'reset'))).toBe(
            'no_reset_time',
        );
    });

    it('refuses to schedule while a retry now still holds its claim before the insert', async () => {
        const { failTask, service, stored, database } = await scheduled();
        const failed = await failTask();
        const record = stored(failed.id);
        database.agentDelegations.save({
            ...record,
            receipt: { ...record.receipt, retriedAs: retryDelegationId(failed.id) },
            retryMode: 'resume',
        });

        expect(await reasonOf(service.retries.retry(failed.id, 'resume', 'reset'))).toBe(
            'already_retried',
        );
        expect(stored(failed.id).receipt.retryScheduledFor).toBeUndefined();
    });

    it('returns the same schedule again, and refuses any other request while pending', async () => {
        const { dueAt, failTask, service } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');

        expect(await service.retries.retry(failed.id, 'resume', 'reset')).toEqual({
            status: 'scheduled',
            delegationId: failed.id,
            scheduledFor: dueAt,
        });
        expect(await reasonOf(service.retries.retry(failed.id, 'resume'))).toBe('schedule_pending');
        expect(await reasonOf(service.retries.retry(failed.id, 'fresh'))).toBe('schedule_pending');
        expect(await reasonOf(service.retries.retry(failed.id, 'fresh', 'reset'))).toBe(
            'schedule_pending',
        );
    });

    it('offers the schedule in the options once a reset time is known', async () => {
        const { dueAt, failTask, service } = await scheduled();
        const failed = await failTask();

        expect((await service.retries.options(failed.id)).schedule).toEqual({
            available: true,
            scheduledFor: dueAt,
        });
        await service.retries.retry(failed.id, 'resume', 'reset');
        expect((await service.retries.options(failed.id)).schedule).toMatchObject({
            available: false,
            unavailableReason: 'schedule_pending',
        });
    });
});

describe('scheduled retry: cancel', () => {
    it('releases the claim so the task is retryable again, and cancels only once', async () => {
        const { failTask, service, stored } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');

        expect(service.retries.cancelScheduled(failed.id)).toEqual({ cancelled: true });
        expect(service.retries.cancelScheduled(failed.id)).toEqual({ cancelled: false });
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
        expect(stored(failed.id).receipt.retryScheduledFor).toBeUndefined();
        expect(stored(failed.id).receipt.retryScheduleOutcome).toBeUndefined();
        expect(await service.retries.retry(failed.id, 'fresh')).toMatchObject({
            status: 'started',
        });
    });

    it('cannot cancel a retry that is already starting', async () => {
        let release!: () => void;
        const { clock, dueAt, failTask, resume, service, stored } = await scheduled();
        const failed = await failTask();
        resume.mockImplementationOnce(async (_id, _principal, _input, options) => {
            const gate = Promise.withResolvers<void>();
            release = gate.resolve;
            await gate.promise;
            options!.beforeResume();
            return { status: 'running' } as never;
        });
        await service.retries.retry(failed.id, 'resume', 'reset');
        clock.now = dueAt;

        const draining = service.retries.drainSchedules();
        await vi.waitFor(() => expect(release).toBeDefined());

        expect(service.retries.cancelScheduled(failed.id)).toEqual({ cancelled: false });
        release();
        await draining;
        expect(stored(retryDelegationId(failed.id))).toBeDefined();
        expect(stored(failed.id).receipt.retryScheduledFor).toBeUndefined();
        expect(stored(failed.id).receipt.retriedAs).toBe(retryDelegationId(failed.id));
    });
});

describe('scheduled retry: firing', () => {
    it('waits for its time, then starts the retry once and tells the Agent', async () => {
        const { clock, dueAt, failTask, resume, service, stored, write } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');

        clock.now = dueAt - 1;
        await service.retries.drainSchedules();
        expect(resume).not.toHaveBeenCalled();

        clock.now = dueAt;
        await service.retries.drainSchedules();
        await service.retries.drainSchedules();

        expect(resume).toHaveBeenCalledTimes(1);
        const successor = stored(retryDelegationId(failed.id));
        expect(successor.receipt).toMatchObject({ retryOf: failed.id, status: 'launching' });
        expect(stored(failed.id).receipt.retryScheduledFor).toBeUndefined();
        expect(stored(failed.id).receipt.retryScheduleOutcome).toBeUndefined();
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('does not start twice when a second pass runs while the first is still starting', async () => {
        let release!: () => void;
        const { clock, dueAt, failTask, resume, service } = await scheduled();
        const failed = await failTask();
        resume.mockImplementationOnce(async (_id, _principal, _input, options) => {
            const gate = Promise.withResolvers<void>();
            release = gate.resolve;
            await gate.promise;
            options!.beforeResume();
            return { status: 'running' } as never;
        });
        await service.retries.retry(failed.id, 'resume', 'reset');
        clock.now = dueAt;

        const first = service.retries.drainSchedules();
        await vi.waitFor(() => expect(release).toBeDefined());
        await service.retries.drainSchedules();
        release();
        await first;

        expect(resume).toHaveBeenCalledTimes(1);
    });

    it('refuses a schedule that came due more than 30 minutes late', async () => {
        const { clock, dueAt, failTask, resume, service, stored, write } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');

        clock.now = dueAt + RETRY_SCHEDULE_MISSED_AFTER_MS + 1;
        await service.retries.drainSchedules();

        expect(resume).not.toHaveBeenCalled();
        expect(stored(failed.id).receipt).toMatchObject({ retryScheduleOutcome: 'missed_window' });
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
        expect(stored(failed.id).receipt.retryScheduledFor).toBeUndefined();
        expect(write).toHaveBeenCalledTimes(1);
        expect(await service.retries.retry(failed.id, 'resume')).toMatchObject({
            status: 'started',
        });
    });

    it('writes the outcome in the same save that releases the claim', async () => {
        const { clock, dueAt, failTask, receiptChanges, service } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');
        receiptChanges.mockClear();

        clock.now = dueAt + RETRY_SCHEDULE_MISSED_AFTER_MS + 1;
        await service.retries.drainSchedules();

        expect(receiptChanges).toHaveBeenCalledTimes(1);
        expect(receiptChanges.mock.calls[0][0]).toMatchObject({
            retryScheduleOutcome: 'missed_window',
            retriedAs: undefined,
        });
    });

    it('refuses with caller_gone when the delegating Agent was replaced', async () => {
        const { clock, dueAt, failTask, resume, service, state, stored } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');

        state.generation = 2;
        clock.now = dueAt;
        await service.retries.drainSchedules();

        expect(resume).not.toHaveBeenCalled();
        expect(stored(failed.id).receipt.retryScheduleOutcome).toBe('caller_gone');
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
    });

    it('ends the schedule early when the user takes the task over', async () => {
        const { database, failTask, service, stored } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');

        const record = stored(failed.id);
        database.agentDelegations.save({ ...record, hasHumanIntervention: true });
        await service.retries.drainSchedules();

        expect(stored(failed.id).receipt.retryScheduleOutcome).toBe('human_input');
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
    });

    it('keeps one failing schedule from blocking the next', async () => {
        const { clock, database, dueAt, failTask, service, stored, verifyLaunch } =
            await scheduled();
        const first = await failTask();
        const second = await failTask();
        await service.retries.retry(first.id, 'resume', 'reset');
        await service.retries.retry(second.id, 'resume', 'reset');
        verifyLaunch.mockRejectedValueOnce(new Error('boom'));

        clock.now = dueAt;
        await service.retries.drainSchedules();

        const outcomes = [first, second].map((task) => ({
            outcome: stored(task.id).receipt.retryScheduleOutcome,
            started: database.agentDelegations.get(retryDelegationId(task.id)) !== undefined,
        }));
        expect(outcomes.filter((entry) => entry.started)).toHaveLength(1);
        expect(outcomes.filter((entry) => entry.outcome === 'internal_error')).toHaveLength(1);
    });
});

describe('scheduled retry: restart', () => {
    it('keeps a pending claim whose task was never stored', async () => {
        const { dueAt, failTask, service, stored } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');

        service.retries.recoverClaims();

        expect(stored(failed.id).receipt).toMatchObject({
            retriedAs: retryDelegationId(failed.id),
            retryScheduledFor: dueAt,
        });
    });

    it('settles instead of replaying when the crash came after the task was stored', async () => {
        const { database, failTask, resume, service, stored } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');
        const record = stored(failed.id);
        database.agentDelegations.insert({
            ...record,
            receipt: {
                ...record.receipt,
                delegationId: retryDelegationId(failed.id),
                retryOf: failed.id,
                retriedAs: undefined,
                retryScheduledFor: undefined,
                status: 'running',
            },
            retryMode: undefined,
        });

        service.retries.recoverClaims();
        await service.retries.drainSchedules();

        expect(stored(failed.id).receipt.retryScheduledFor).toBeUndefined();
        expect(stored(failed.id).receipt.retriedAs).toBe(retryDelegationId(failed.id));
        expect(resume).not.toHaveBeenCalled();
    });

    it('starts the poll only when asked, and a due schedule fires on that first pass', async () => {
        const registerPoller = vi.fn(() => ({ dispose: () => Promise.resolve() }));
        const { clock, dueAt, failTask, resume, service, stored } = await scheduled();
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');
        clock.now = dueAt;

        expect(registerPoller).not.toHaveBeenCalled();
        service.retries.startSchedules({ registerPoller } as never);
        expect(registerPoller).toHaveBeenCalledWith(
            expect.objectContaining({ label: 'delegation-retry-schedules' }),
        );
        await vi.waitFor(() => expect(stored(retryDelegationId(failed.id))).toBeDefined());
        expect(resume).toHaveBeenCalledTimes(1);
    });
});

describe('scheduled retry: Chat usage-limit wait', () => {
    it('cancels the Chat wait when the schedule fires', async () => {
        const claimChatUsageLimitWait = vi.fn(() => 'cancelled' as const);
        const { clock, dueAt, failTask, service, stored } = await scheduled({
            claimChatUsageLimitWait,
        });
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');
        claimChatUsageLimitWait.mockClear();

        clock.now = dueAt;
        await service.retries.drainSchedules();

        expect(claimChatUsageLimitWait).toHaveBeenCalled();
        expect(stored(retryDelegationId(failed.id))).toBeDefined();
    });

    it('refuses with target_busy when the Chat wait is already continuing', async () => {
        const claim = vi.fn<() => 'cancelled' | 'none' | 'running'>(() => 'none');
        const { clock, dueAt, failTask, resume, service, stored } = await scheduled({
            claimChatUsageLimitWait: claim,
        });
        const failed = await failTask();
        await service.retries.retry(failed.id, 'resume', 'reset');

        claim.mockReturnValue('running');
        clock.now = dueAt;
        await service.retries.drainSchedules();

        expect(resume).not.toHaveBeenCalled();
        expect(stored(failed.id).receipt.retryScheduleOutcome).toBe('target_busy');
        expect(stored(failed.id).receipt.retriedAs).toBeUndefined();
    });
});

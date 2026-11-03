import type { AgentDelegationReceipt } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { laterResetTime, stampedReceipt } from '../receipt-timing';

const running: AgentDelegationReceipt = {
    delegationId: 'task',
    projectId: 'project',
    sessionId: 'session',
    terminalId: 'terminal',
    provider: 'claude',
    status: 'running',
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
};
const stamp = (
    receipt: AgentDelegationReceipt,
    before: AgentDelegationReceipt | undefined,
    now: number,
    resetsAt?: (failure: {
        provider: string;
        terminalId?: string;
        turnId?: string;
    }) => number | undefined,
) => stampedReceipt({ receipt, turnId: 'turn-1' }, before, now, resetsAt);

describe('settledAt', () => {
    it('is set when the task moves from active to settled and kept by later saves', () => {
        const completed = stamp({ ...running, status: 'completed' }, running, 500);
        expect(completed).toMatchObject({
            status: 'completed',
            settledAt: 500,
            updatedAt: 500,
            revision: 2,
        });

        const claimed = stamp(completed, completed, 900);
        expect(claimed).toMatchObject({ settledAt: 500, updatedAt: 900 });
    });

    it('stays absent while the task is active', () => {
        expect(
            stamp({ ...running, status: 'blocked', failure: 'permission_required' }, running, 200),
        ).not.toHaveProperty('settledAt');
    });

    it('is never carried by an active receipt, even one copied from a settled receipt (defensive invariant)', () => {
        const settled = stamp({ ...running, status: 'completed' }, running, 500);
        const again = stamp({ ...settled, status: 'submitting' }, settled, 600);
        expect(again).not.toHaveProperty('settledAt');

        expect(stamp({ ...again, status: 'completed' }, again, 700).settledAt).toBe(700);
    });
});

describe('failureResetsAt', () => {
    it('records the reset time looked up when the task fails on a usage limit', () => {
        const resetsAt = vi.fn(() => 9000);

        const failed = stamp(
            { ...running, status: 'failed', failure: 'quota_exhausted' },
            running,
            500,
            resetsAt,
        );

        expect(failed.failureResetsAt).toBe(9000);
        expect(resetsAt).toHaveBeenCalledWith({
            provider: 'claude',
            terminalId: 'terminal',
            turnId: 'turn-1',
        });
        expect(
            stamp(
                { ...running, status: 'failed', failure: 'rate_limited' },
                running,
                500,
                () => 9000,
            ).failureResetsAt,
        ).toBe(9000);
    });

    it('stays absent when no reset time is known, or the one known is not in the future', () => {
        const failed = {
            ...running,
            status: 'failed' as const,
            failure: 'quota_exhausted' as const,
        };

        expect(stamp(failed, running, 500)).not.toHaveProperty('failureResetsAt');
        expect(stamp(failed, running, 500, () => {})).not.toHaveProperty('failureResetsAt');
        expect(stamp(failed, running, 500, () => 400)).not.toHaveProperty('failureResetsAt');
        expect(stamp(failed, running, 500, () => 600.5)).not.toHaveProperty('failureResetsAt');
    });

    it('is not looked up for another failure', () => {
        const resetsAt = vi.fn(() => 9000);

        const failed = stamp(
            { ...running, status: 'failed', failure: 'provider_failed' },
            running,
            500,
            resetsAt,
        );

        expect(failed).not.toHaveProperty('failureResetsAt');
        expect(resetsAt).not.toHaveBeenCalled();
    });

    it('is kept by a later save without looking it up again, and never carried by an active receipt', () => {
        const resetsAt = vi.fn(() => 9000);
        const failed = stamp(
            { ...running, status: 'failed', failure: 'quota_exhausted' },
            running,
            500,
            resetsAt,
        );

        const claimed = stamp(failed, failed, 20_000, resetsAt);
        expect(claimed.failureResetsAt).toBe(9000);
        expect(resetsAt).toHaveBeenCalledTimes(1);

        const resumed = stamp(
            { ...failed, status: 'submitting', failure: undefined },
            failed,
            21_000,
            resetsAt,
        );
        expect(resumed).not.toHaveProperty('failureResetsAt');
        expect(resumed).not.toHaveProperty('settledAt');
    });
});

describe('laterResetTime', () => {
    it('is the limit notice when only the notice is known', () => {
        expect(laterResetTime(9000, undefined)).toBe(9000);
    });

    it('is the usage guard when only the guard is known', () => {
        expect(laterResetTime(undefined, 7000)).toBe(7000);
    });

    it.each([
        [9000, 7000, 9000],
        [7000, 9000, 9000],
    ])('is the later of a notice at %i and a guard at %i', (noticed, guarded, expected) => {
        expect(laterResetTime(noticed, guarded)).toBe(expected);
    });

    it('is unknown when neither source knows a time', () => {
        expect(laterResetTime(undefined, undefined)).toBeUndefined();
    });

    it('never lets a malformed time win', () => {
        expect(laterResetTime(NaN, 7000)).toBe(7000);
        expect(laterResetTime(Infinity, undefined)).toBeUndefined();
        expect(laterResetTime(7000, 1e300)).toBe(7000);
    });

    it('lets a notice already past lose to a later guard, and leaves a past time alone for the receipt to drop', () => {
        expect(laterResetTime(400, 9000)).toBe(9000);
        const failed = {
            ...running,
            status: 'failed' as const,
            failure: 'quota_exhausted' as const,
        };

        const stamped = stamp(failed, running, 500, () => laterResetTime(400, undefined));

        expect(stamped).not.toHaveProperty('failureResetsAt');
        expect(stamp(failed, running, 500, () => laterResetTime(400, 9000)).failureResetsAt).toBe(
            9000,
        );
    });
});

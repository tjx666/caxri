import { describe, expect, it, vi } from 'vitest';

import {
    CLAUDE_PLAN_LIMITS_REFRESH_MS,
    ClaudePlanLimits,
    claudePlanLimits,
    claudeRateLimitEvent,
    readClaudePlanLimits,
} from '../claude-plan-limits';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');

describe('claudePlanLimits', () => {
    it('reads the 5-hour and weekly windows and the plan from a /usage answer', () => {
        expect(
            claudePlanLimits(
                {
                    subscription_type: 'max',
                    rate_limits_available: true,
                    rate_limits: {
                        five_hour: { utilization: 38.5, resets_at: '2026-10-19T14:00:00.000Z' },
                        seven_day: { utilization: 112, resets_at: null },
                        seven_day_opus: { utilization: 90, resets_at: null },
                    },
                },
                NOW,
            ),
        ).toEqual({
            observedAt: NOW,
            planType: 'max',
            windows: [
                {
                    windowMinutes: 300,
                    scope: 'session',
                    usedPercent: 38.5,
                    resetsAt: Date.parse('2026-10-19T14:00:00.000Z'),
                },
                { windowMinutes: 10_080, usedPercent: 100, scope: 'weekly' },
            ],
        });
    });

    it('has no reading for an API key, an unknown utilization, or a malformed answer', () => {
        expect(claudePlanLimits({ rate_limits_available: false, rate_limits: null }, NOW)).toBe(
            undefined,
        );
        expect(
            claudePlanLimits({ rate_limits: { five_hour: { utilization: null } } }, NOW),
        ).toBeUndefined();
        expect(claudePlanLimits('nope', NOW)).toBeUndefined();
    });

    it('asks nothing without an open process and swallows a failed request', async () => {
        await expect(readClaudePlanLimits(undefined)).resolves.toBeUndefined();
        await expect(
            readClaudePlanLimits({
                usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
                    Promise.reject(new Error('unsupported')),
            }),
        ).resolves.toBeUndefined();
    });
});

const answer = {
    subscription_type: 'max',
    rate_limits: {
        five_hour: { utilization: 20, resets_at: '2026-10-19T14:00:00.000Z' },
        seven_day: { utilization: 40, resets_at: '2026-10-23T00:00:00.000Z' },
    },
};

describe('ClaudePlanLimits', () => {
    it('asks once per refresh window and applies rate-limit events in between', async () => {
        let now = NOW;
        // The SDK types the full answer; the reader looks only at the fields this fixture carries.
        const usage = vi.fn(() => Promise.resolve(answer as never));
        const query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage };
        const limits = new ClaudePlanLimits(undefined, () => now);
        limits.observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.9 });
        await expect(limits.read(query)).resolves.toMatchObject({
            windows: [{ usedPercent: 20 }, { usedPercent: 40 }],
        });
        now += 1000;
        const resetsAt = Date.parse('2026-10-19T15:00:00.000Z');
        limits.observe({
            status: 'allowed_warning',
            rateLimitType: 'five_hour',
            utilization: 0.85,
            resetsAt: resetsAt / 1000,
        });
        limits.observe({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 1 });
        await expect(limits.read(query)).resolves.toEqual({
            observedAt: now,
            planType: 'max',
            windows: [
                { windowMinutes: 300, usedPercent: 85, resetsAt, scope: 'session' },
                {
                    windowMinutes: 10_080,
                    scope: 'weekly',
                    usedPercent: 40,
                    resetsAt: Date.parse('2026-10-23T00:00:00.000Z'),
                },
            ],
        });
        expect(usage).toHaveBeenCalledTimes(1);
        now = NOW + CLAUDE_PLAN_LIMITS_REFRESH_MS;
        await limits.read(query);
        expect(usage).toHaveBeenCalledTimes(2);
        await expect(limits.read(undefined)).resolves.toBeUndefined();
    });

    it('treats a rejected window without a figure as used up', () => {
        const reading = claudePlanLimits(answer, NOW);
        if (!reading) throw new Error('expected a reading');
        expect(
            claudeRateLimitEvent(reading, { status: 'rejected', rateLimitType: 'seven_day' }, NOW)
                ?.windows[1],
        ).toEqual({ windowMinutes: 10_080, usedPercent: 100, scope: 'weekly' });
        expect(claudeRateLimitEvent(reading, { status: 'allowed' }, NOW)).toBeUndefined();
    });
});

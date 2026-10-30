import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    CLAUDE_PLAN_LIMITS_REFRESH_MS,
    claudeExtraUsageCredits,
    claudeExtraUsageEnabled,
    ClaudePlanLimits,
    claudePlanLimits,
    claudeRateLimitEvent,
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
        const limits = new ClaudePlanLimits({ now: () => now });
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

    it('attaches the rate-limit tier to subscription readings, read once per Chat', async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-claude-plan-tier-'));
        onTestFinished(() => rm(home, { force: true, recursive: true }));
        const config = join(home, '.claude.json');
        const writeTier = (tier: string) =>
            writeFile(
                config,
                JSON.stringify({ oauthAccount: { organizationRateLimitTier: tier } }),
            );
        await writeTier('default_claude_max_5x');
        let now = NOW;
        const usage = vi.fn(() => Promise.resolve(answer as never));
        const query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage };
        const readEnvironment = () => ({ HOME: home });
        const limits = new ClaudePlanLimits({ now: () => now, readEnvironment });
        await expect(limits.read(query)).resolves.toMatchObject({
            planType: 'max',
            rateLimitTier: 'default_claude_max_5x',
        });
        // Cached for the Chat: a later config change is not read again.
        await writeTier('default_claude_max_20x');
        now += CLAUDE_PLAN_LIMITS_REFRESH_MS;
        limits.observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 });
        await expect(limits.read(query)).resolves.toMatchObject({
            rateLimitTier: 'default_claude_max_5x',
        });
        usage.mockResolvedValueOnce({ rate_limits: answer.rate_limits } as never);
        const apiKey = new ClaudePlanLimits({ now: () => now, readEnvironment });
        await expect(apiKey.read(query)).resolves.not.toHaveProperty('rateLimitTier');
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

describe('claudeExtraUsageCredits', () => {
    it('reads what is left of the monthly cap, in major units of its currency', () => {
        expect(
            claudeExtraUsageCredits({
                is_enabled: true,
                monthly_limit: 5000,
                used_credits: 1260,
                utilization: 25.2,
                currency: 'usd',
            }),
        ).toEqual({ unlimited: false, balance: 37.4, currency: 'USD' });
        expect(
            claudeExtraUsageCredits({ is_enabled: true, monthly_limit: 2000, used_credits: null }),
        ).toEqual({ unlimited: false, balance: 20, currency: 'USD' });
        expect(
            claudeExtraUsageCredits({ is_enabled: true, monthly_limit: 300, used_credits: 900 }),
        ).toEqual({ unlimited: false, balance: 0, currency: 'USD' });
        expect(
            claudeExtraUsageCredits({ is_enabled: true, monthly_limit: 500, currency: 'JPY' }),
        ).toEqual({ unlimited: false, balance: 500, currency: 'JPY' });
    });

    it('has credits without a balance when no cap is set, and none while extra usage is off', () => {
        expect(claudeExtraUsageCredits({ is_enabled: true, monthly_limit: null })).toEqual({
            unlimited: false,
        });
        expect(
            claudeExtraUsageCredits({ is_enabled: false, monthly_limit: 5000, used_credits: 0 }),
        ).toBeUndefined();
        expect(claudeExtraUsageCredits(null)).toBeUndefined();
    });

    it('attaches the credits to a /usage reading', () => {
        expect(
            claudePlanLimits(
                {
                    ...answer,
                    rate_limits: {
                        ...answer.rate_limits,
                        extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 250 },
                    },
                },
                NOW,
            )?.credits,
        ).toEqual({ unlimited: false, balance: 7.5, currency: 'USD' });
    });

    it('follows what a rate-limit event says about extra usage', () => {
        const reading = claudePlanLimits(
            {
                ...answer,
                rate_limits: {
                    ...answer.rate_limits,
                    extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 250 },
                },
            },
            NOW,
        );
        if (!reading) throw new Error('expected a reading');
        const weekly = { rateLimitType: 'seven_day', utilization: 0.995 } as const;
        expect(
            claudeRateLimitEvent(
                reading,
                { ...weekly, status: 'allowed', overageStatus: 'allowed' },
                NOW,
            )?.credits,
        ).toEqual(reading.credits);
        expect(
            claudeRateLimitEvent(reading, { ...weekly, status: 'allowed' }, NOW)?.credits,
        ).toEqual(reading.credits);
        expect(
            claudeRateLimitEvent(
                reading,
                {
                    ...weekly,
                    status: 'rejected',
                    overageStatus: 'rejected',
                    overageDisabledReason: 'out_of_credits',
                },
                NOW,
            ),
        ).not.toHaveProperty('credits');
        expect(
            claudeRateLimitEvent(
                { observedAt: 0, windows: [] },
                { ...weekly, status: 'rejected', isUsingOverage: true },
                NOW,
            )?.credits,
        ).toEqual({ unlimited: false });
    });
});

describe('claudeExtraUsageEnabled', () => {
    it('reads whether extra usage is on, and nothing from an answer that does not say', () => {
        const withExtra = (extra_usage: unknown) => ({
            ...answer,
            rate_limits: { ...answer.rate_limits, extra_usage },
        });
        expect(claudeExtraUsageEnabled(withExtra({ is_enabled: true }))).toBe(true);
        expect(claudeExtraUsageEnabled(withExtra({ is_enabled: false }))).toBe(false);
        expect(claudeExtraUsageEnabled(withExtra(null))).toBeUndefined();
        expect(claudeExtraUsageEnabled(answer)).toBeUndefined();
        expect(claudeExtraUsageEnabled({ rate_limits: null })).toBeUndefined();
    });
});

describe('ClaudePlanLimits extra usage', () => {
    it('asks nothing without an open process and swallows a failed request', async () => {
        const onExtraUsage = vi.fn();
        const limits = new ClaudePlanLimits({ onExtraUsage });
        await expect(limits.read(undefined)).resolves.toBeUndefined();
        await expect(
            limits.read({
                usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
                    Promise.reject(new Error('unsupported')),
            }),
        ).resolves.toBeUndefined();
        expect(onExtraUsage).not.toHaveBeenCalled();
    });

    it('reports whether extra usage is on with each answer', async () => {
        let now = NOW;
        const onExtraUsage = vi.fn();
        let isEnabled = false;
        const query = {
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
                Promise.resolve({
                    ...answer,
                    rate_limits: { ...answer.rate_limits, extra_usage: { is_enabled: isEnabled } },
                } as never),
        };
        const limits = new ClaudePlanLimits({ onExtraUsage, now: () => now });
        await limits.read(query);
        expect(onExtraUsage).toHaveBeenLastCalledWith(false);
        isEnabled = true;
        now += CLAUDE_PLAN_LIMITS_REFRESH_MS;
        await limits.read(query);
        expect(onExtraUsage).toHaveBeenLastCalledWith(true);
        expect(onExtraUsage).toHaveBeenCalledTimes(2);
    });
});

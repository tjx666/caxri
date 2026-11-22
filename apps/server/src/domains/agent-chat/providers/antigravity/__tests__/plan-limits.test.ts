import { describe, expect, it, vi } from 'vitest';

import type { AntigravityUsageAnswer } from '../../../../agents';
import {
    ANTIGRAVITY_PLAN_LIMITS_REFRESH_MS,
    ANTIGRAVITY_PLAN_LIMITS_RETRY_MS,
    AntigravityPlanLimits,
    antigravityUsageLimit,
} from '../plan-limits';

const reading = (usedPercent: number) => ({
    observedAt: 1,
    windows: [{ windowMinutes: 300, usedPercent, scope: 'session' as const, group: 'Gemini' }],
});

describe('AntigravityPlanLimits', () => {
    it('reuses a reading within the refresh window and reads again when asked fresh', async () => {
        let time = 0;
        const run = vi.fn((): Promise<AntigravityUsageAnswer> =>
            Promise.resolve({ status: 'signedIn', limit: reading(10) }),
        );
        const limits = new AntigravityPlanLimits(run, () => time);
        await expect(limits.read()).resolves.toEqual(reading(10));
        time = ANTIGRAVITY_PLAN_LIMITS_REFRESH_MS - 1;
        await limits.read();
        expect(run).toHaveBeenCalledTimes(1);
        await limits.read(true);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('runs one command at a time and drops the reading on sign-out', async () => {
        let answer: AntigravityUsageAnswer = { status: 'signedIn', limit: reading(20) };
        const run = vi.fn(() => Promise.resolve(answer));
        const limits = new AntigravityPlanLimits(run, () => 0);
        await Promise.all([limits.read(true), limits.read(true)]);
        expect(run).toHaveBeenCalledTimes(1);
        answer = { status: 'signedOut' };
        await expect(limits.read(true)).resolves.toBeUndefined();
    });

    it('keeps the last good reading through a failed read and retries it soon', async () => {
        let time = 0;
        let answer: AntigravityUsageAnswer = { status: 'signedIn', limit: reading(20) };
        const run = vi.fn(() => Promise.resolve(answer));
        const limits = new AntigravityPlanLimits(run, () => time);
        await limits.read();
        answer = { status: 'unknown' };
        await expect(limits.read(true)).resolves.toEqual(reading(20));
        time = ANTIGRAVITY_PLAN_LIMITS_RETRY_MS - 1;
        await limits.read();
        expect(run).toHaveBeenCalledTimes(2);
        time = ANTIGRAVITY_PLAN_LIMITS_RETRY_MS;
        await limits.read();
        expect(run).toHaveBeenCalledTimes(3);
    });
});

describe('antigravityUsageLimit', () => {
    const now = 1_000;
    const limit = {
        observedAt: now,
        windows: [
            {
                windowMinutes: 300,
                usedPercent: 100,
                resetsAt: now + 10,
                scope: 'session' as const,
                group: 'Gemini',
            },
            {
                windowMinutes: 10_080,
                usedPercent: 100,
                resetsAt: now + 99,
                scope: 'weekly' as const,
                group: 'Claude & GPT',
            },
        ],
    };

    it("names the used-up window of the conversation model's group", () => {
        expect(antigravityUsageLimit(limit, 'gemini-3.8-flash')).toEqual({
            window: 'session',
            resetsAt: now + 10,
        });
        expect(antigravityUsageLimit(limit, 'claude-sonnet-4-6')).toEqual({
            window: 'weekly',
            resetsAt: now + 99,
        });
    });

    it('falls back to any used-up window, and to unknown without one', () => {
        expect(antigravityUsageLimit(limit, 'other-model')).toEqual({
            window: 'weekly',
            resetsAt: now + 99,
        });
        expect(antigravityUsageLimit(undefined, 'gemini-3.8-flash')).toEqual({
            window: 'unknown',
        });
    });
});

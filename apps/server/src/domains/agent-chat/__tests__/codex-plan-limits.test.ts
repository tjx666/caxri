import { describe, expect, it, vi } from 'vitest';

import { CodexUsageLimits } from '../continuation/codex-usage-limit';

const NOW = 1_800_000_000_000;

/**
 * A rate-limit snapshot in the shape `account/rateLimits/read` answers with (codex-cli 0.165 app-server schema).
 */
function snapshot(limitId: string | null, usedPercent: number) {
    return {
        limitId,
        planType: 'pro',
        primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_800_007_200 },
        secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: null },
    };
}

describe('CodexUsageLimits.read', () => {
    it('asks for the general limit with reset-credit details and reports its windows', async () => {
        const request = vi.fn(() =>
            Promise.resolve({
                rateLimits: snapshot('codex_other_model', 3),
                rateLimitsByLimitId: { codex: snapshot('codex', 100) },
            }),
        );
        const limits = new CodexUsageLimits();

        await expect(limits.read(request, NOW)).resolves.toEqual({
            observedAt: NOW,
            planType: 'pro',
            windows: [
                {
                    windowMinutes: 300,
                    usedPercent: 100,
                    resetsAt: 1_800_007_200_000,
                    scope: 'session',
                },
                { windowMinutes: 10_080, usedPercent: 41, scope: 'weekly' },
            ],
        });
        expect(request).toHaveBeenCalledWith('account/rateLimits/read', {}, 10_000);
        // The reading also attributes a later usage-limit failure.
        expect(limits.usageLimit(NOW)).toEqual({ window: 'session', resetsAt: 1_800_007_200_000 });
    });

    it('falls back to the single-bucket view only when it is the general limit', async () => {
        const single = (limitId: string | null) => () =>
            Promise.resolve({ rateLimits: snapshot(limitId, 100) });
        const limits = new CodexUsageLimits();

        await expect(limits.read(single(null), NOW)).resolves.toMatchObject({
            windows: [{ usedPercent: 100 }, { usedPercent: 41 }],
        });
        await expect(limits.read(single('codex_other_model'), NOW)).resolves.toBeUndefined();
        await expect(limits.read(() => Promise.resolve(null), NOW)).resolves.toBeUndefined();
    });

    it("reports the account's usable credits with the windows", async () => {
        const withCredits = (credits: unknown) => () =>
            Promise.resolve({ rateLimits: { ...snapshot('codex', 99), credits } });
        const limits = new CodexUsageLimits();

        await expect(
            limits.read(
                withCredits({ hasCredits: true, unlimited: false, balance: '1250.4' }),
                NOW,
            ),
        ).resolves.toMatchObject({ credits: { unlimited: false, balance: 1250.4 } });
        await expect(
            limits.read(withCredits({ hasCredits: false, unlimited: false, balance: null }), NOW),
        ).resolves.not.toHaveProperty('credits');
    });
});

describe('CodexUsageLimits.read banked resets', () => {
    it('reports the account-wide reset credit summary beside the windows', async () => {
        const credit = {
            id: 'a',
            status: 'available',
            resetType: 'codexRateLimits',
            grantedAt: 1,
            expiresAt: 1_800_259_200,
        };
        const answer = (rateLimitResetCredits: unknown) => () =>
            Promise.resolve({ rateLimits: snapshot('codex', 10), rateLimitResetCredits });
        const limits = new CodexUsageLimits();

        await expect(
            limits.read(answer({ availableCount: 2, credits: [credit] }), NOW),
        ).resolves.toMatchObject({
            resetCredits: { availableCount: 2, nextExpiresAt: 1_800_259_200_000 },
        });
        await expect(limits.read(answer({ availableCount: 0 }), NOW)).resolves.not.toHaveProperty(
            'resetCredits',
        );
        await expect(limits.read(answer(undefined), NOW)).resolves.not.toHaveProperty(
            'resetCredits',
        );
    });
});

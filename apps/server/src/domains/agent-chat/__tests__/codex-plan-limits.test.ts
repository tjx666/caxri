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
    it('asks for the general limit without reset-credit details and reports its windows', async () => {
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
        expect(request).toHaveBeenCalledWith(
            'account/rateLimits/read',
            { excludeResetCreditDetails: true },
            10_000,
        );
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
});

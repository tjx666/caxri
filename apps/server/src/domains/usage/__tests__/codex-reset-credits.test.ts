import { describe, expect, it } from 'vitest';

import { codexResetCredits } from '../codex-reset-credits';

describe('codexResetCredits', () => {
    const EXPIRES = Date.parse('2026-11-12T00:00:00.000Z');
    const credit = (status: string, expiresAt: unknown) => ({
        id: status,
        status,
        resetType: 'codexRateLimits',
        grantedAt: 1_790_000_000,
        expiresAt,
    });

    it('counts the available credits and takes the soonest expiry in seconds', () => {
        expect(
            codexResetCredits({
                availableCount: 2,
                credits: [
                    credit('available', EXPIRES / 1000 + 86_400),
                    credit('available', EXPIRES / 1000),
                ],
            }),
        ).toEqual({ availableCount: 2, nextExpiresAt: EXPIRES });
    });

    it('reads an ISO string expiry and ignores credits that are not available', () => {
        const iso = new Date(EXPIRES).toISOString();
        expect(
            codexResetCredits({
                availableCount: 1,
                credits: [credit('redeemed', EXPIRES / 1000 - 3600), credit('available', iso)],
            }),
        ).toEqual({ availableCount: 1, nextExpiresAt: EXPIRES });
    });

    it('keeps the count without an expiry when details are absent or never expire', () => {
        expect(codexResetCredits({ availableCount: 3, credits: null })).toEqual({
            availableCount: 3,
        });
        expect(
            codexResetCredits({ availableCount: 1, credits: [credit('available', null)] }),
        ).toEqual({ availableCount: 1 });
    });

    it('reports nothing for no credits, a missing field, or a malformed count', () => {
        expect(codexResetCredits({ availableCount: 0, credits: [] })).toBeUndefined();
        expect(codexResetCredits(undefined)).toBeUndefined();
        expect(codexResetCredits(null)).toBeUndefined();
        expect(codexResetCredits({})).toBeUndefined();
        expect(codexResetCredits({ availableCount: '2' })).toBeUndefined();
    });
});

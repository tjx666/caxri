import { describe, expect, it } from 'vitest';

import type { UsageLimit } from '../../domain/usage-contract.js';
import {
    CREDITS_NOTICE_DISMISS_MS,
    weeklyCreditsNotice,
    weeklyCreditsWindow,
    weeklyUsageGuardWindow,
} from '../agent-usage-continuation.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const resetsAt = NOW + 2 * 86_400_000;

const limit = (usedPercent: number, credits?: UsageLimit['credits']): UsageLimit => ({
    provider: 'codex',
    observedAt: NOW,
    windows: [{ windowMinutes: 10_080, usedPercent, resetsAt, scope: 'weekly' }],
    ...(credits && { credits }),
});

describe('weeklyCreditsNotice', () => {
    it('shows at the guard while the account has usable credits, where the guard stays off', () => {
        const atGuard = limit(99.2, { unlimited: false, balance: 1250 });
        expect(weeklyUsageGuardWindow(atGuard, NOW)).toBeUndefined();
        expect(weeklyCreditsNotice(atGuard, NOW)).toEqual({
            usedPercent: 99.2,
            resetsAt,
            credits: { unlimited: false, balance: 1250 },
        });
    });

    it('gives way to the guard without credits and stays away below the guard', () => {
        const spent = limit(99.2, { unlimited: false, balance: 0 });
        expect(weeklyCreditsNotice(spent, NOW)).toBeUndefined();
        expect(weeklyUsageGuardWindow(spent, NOW)).toEqual({ usedPercent: 99.2, resetsAt });
        expect(weeklyCreditsNotice(limit(80, { unlimited: true }), NOW)).toBeUndefined();
    });

    it('stays hidden for a day after a dismissal, while the window still counts as on credits', () => {
        const dismissed = {
            ...limit(99.5, { unlimited: true }),
            creditsNoticeDismissedAt: NOW - 60_000,
        };
        expect(weeklyCreditsNotice(dismissed, NOW)).toBeUndefined();
        expect(weeklyCreditsWindow(dismissed, NOW)).toBeDefined();
        expect(
            weeklyCreditsNotice(dismissed, NOW - 60_000 + CREDITS_NOTICE_DISMISS_MS),
        ).toBeDefined();
    });
});

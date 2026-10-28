import { describe, expect, it } from 'vitest';

import {
    agentUsageCostLabel,
    currentLimitWindows,
    formatPercent,
    formatTokens,
    formatUsd,
    isPlanPaceDismissed,
    limitPaceShortfall,
    localDateWeekday,
    remainingLimitPercent,
    shiftLocalDate,
    tokenCountParts,
} from '../usage-format.js';

describe('usage formatters', () => {
    it('formats dollars by magnitude', () => {
        expect(formatUsd(0)).toBe('$0');
        expect(formatUsd(0.001)).toBe('<$0.01');
        expect(formatUsd(12.345)).toBe('$12.35');
        expect(formatUsd(999.996)).toBe('$1,000');
        expect(formatUsd(12_345.4)).toBe('$12,345');
        expect(formatUsd(1_234_567)).toBe('$1,235k');
    });

    it('formats token counts without rolling over to `1000k`', () => {
        expect(formatTokens(999)).toBe('999');
        expect(formatTokens(999_999)).toBe('1M');
        expect(formatTokens(1_250_000)).toBe('1.3M');
    });

    it('splits a token count into the figure and suffix that format it', () => {
        expect(tokenCountParts(900.4)).toEqual({ value: 900, suffix: '' });
        expect(tokenCountParts(38_940)).toEqual({ value: 38.9, suffix: 'k' });
        expect(tokenCountParts(389_000)).toEqual({ value: 389, suffix: 'k' });
        expect(tokenCountParts(999_999)).toEqual({ value: 1, suffix: 'M' });
    });

    it('formats ratios', () => {
        expect(formatPercent(0.0004)).toBe('<0.1%');
        expect(formatPercent(0.054)).toBe('5.4%');
        expect(formatPercent(0.5)).toBe('50%');
    });
});

describe('local date arithmetic', () => {
    it('shifts across month, year, and daylight-saving boundaries', () => {
        expect(shiftLocalDate('2026-03-31', 1)).toBe('2026-04-01');
        expect(shiftLocalDate('2026-01-01', -1)).toBe('2025-12-31');
        expect(shiftLocalDate('2026-03-07', 2)).toBe('2026-03-09');
        expect(localDateWeekday('2026-03-08')).toBe(0);
    });
});

describe('rate-limit windows', () => {
    const NOW = Date.parse('2026-10-11T12:00:00.000Z');

    it('keeps a window without a reset time, drops a reset one, and orders shortest first', () => {
        const windows = currentLimitWindows(
            {
                provider: 'codex',
                observedAt: NOW,
                windows: [
                    { windowMinutes: 10_080, usedPercent: 1 },
                    { windowMinutes: 300, usedPercent: 2, resetsAt: NOW + 1 },
                    { windowMinutes: 60, usedPercent: 3, resetsAt: NOW },
                ],
            },
            NOW,
        );
        expect(windows.map((window) => window.windowMinutes)).toEqual([300, 10_080]);
        expect(currentLimitWindows(null, NOW)).toEqual([]);
    });

    it('states the share left, rounded and clamped', () => {
        expect(remainingLimitPercent(8)).toBe(92);
        expect(remainingLimitPercent(61.6)).toBe(38);
        expect(remainingLimitPercent(104)).toBe(0);
    });
});

describe('limitPaceShortfall', () => {
    const NOW = Date.parse('2026-10-19T12:00:00.000Z');
    const DAY = 86_400_000;
    const weekly = (usedPercent: number, daysLeft: number) => ({
        provider: 'claude' as const,
        observedAt: NOW,
        windows: [
            { windowMinutes: 300, usedPercent: 99, resetsAt: NOW + 3_600_000 },
            { windowMinutes: 10_080, usedPercent, resetsAt: NOW + daysLeft * DAY },
        ],
    });

    it('reports a weekly window whose pace so far would run it out before it resets', () => {
        // 60% used in 2 of 7 days projects 210%, so the week runs out.
        expect(limitPaceShortfall(weekly(60, 5), NOW)).toEqual({
            window: { windowMinutes: 10_080, usedPercent: 60, resetsAt: NOW + 5 * DAY },
            evenPacePercent: 71,
        });
    });

    it('stays quiet on first-workday bursts, on course, for short windows, and without a reset time', () => {
        // 14% used after 12 hours of 7 days: less than a tenth of the window has elapsed, too early to project.
        expect(limitPaceShortfall(weekly(14, 6.5), NOW)).toBeUndefined();
        // 20% used in 2 of 7 days projects 70%: the week lasts.
        expect(limitPaceShortfall(weekly(20, 5), NOW)).toBeUndefined();
        // 28% used in 2 of 7 days projects exactly 98%, still short of the limit.
        expect(limitPaceShortfall(weekly(28, 5), NOW)).toBeUndefined();
        expect(
            limitPaceShortfall(
                {
                    provider: 'codex',
                    observedAt: NOW,
                    windows: [{ windowMinutes: 10_080, usedPercent: 90 }],
                },
                NOW,
            ),
        ).toBeUndefined();
        expect(limitPaceShortfall(null, NOW)).toBeUndefined();
    });

    it('starts projecting once a tenth of the window has elapsed', () => {
        // 0.8 of 7 days elapsed is past 10%: 14% used projects about 123%.
        expect(limitPaceShortfall(weekly(14, 6.2), NOW)?.window.usedPercent).toBe(14);
    });
});

describe('isPlanPaceDismissed', () => {
    it('holds a dismissal until the next local midnight', () => {
        const evening = new Date(2026, 9, 27, 23, 0).getTime();
        const limit = { paceDismissedAt: evening };
        expect(isPlanPaceDismissed(limit, evening + 30 * 60_000)).toBe(true);
        expect(isPlanPaceDismissed(limit, new Date(2026, 9, 28, 0, 1).getTime())).toBe(false);
    });

    it('treats a dismissal from before today as stale and a missing one as not dismissed', () => {
        const now = new Date(2026, 9, 28, 9, 0).getTime();
        expect(
            isPlanPaceDismissed({ paceDismissedAt: new Date(2026, 9, 27, 12, 0).getTime() }, now),
        ).toBe(false);
        expect(
            isPlanPaceDismissed({ paceDismissedAt: new Date(2026, 9, 28, 0, 0).getTime() }, now),
        ).toBe(true);
        expect(isPlanPaceDismissed({}, now)).toBe(false);
        expect(isPlanPaceDismissed(undefined, now)).toBe(false);
    });
});

describe('agentUsageCostLabel', () => {
    it('marks a cost that leaves some unpriced models out as a lower bound, and omits an all-unpriced one', () => {
        const priced = { costUsd: 3.4, models: ['gpt-5.5'], unpricedModels: [] };
        expect(agentUsageCostLabel(priced)).toBe('$3.40');
        expect(
            agentUsageCostLabel({
                ...priced,
                models: ['gpt-5.5', 'mystery'],
                unpricedModels: ['mystery'],
            }),
        ).toBe('≥$3.40');
        expect(agentUsageCostLabel({ ...priced, unpricedModels: ['gpt-5.5'] })).toBeUndefined();
    });
});

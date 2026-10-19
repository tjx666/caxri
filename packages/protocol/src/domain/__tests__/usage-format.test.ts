import { describe, expect, it } from 'vitest';

import {
    currentLimitWindows,
    formatPercent,
    formatTokens,
    formatUsd,
    limitPaceShortfall,
    localDateWeekday,
    remainingLimitPercent,
    shiftLocalDate,
    shortLimitWindowName,
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

    it('names windows compactly and states the share left, rounded and clamped', () => {
        expect(shortLimitWindowName(300)).toBe('5h');
        expect(shortLimitWindowName(10_080)).toBe('7d');
        expect(shortLimitWindowName(90)).toBe('90m');
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

    it('reports a weekly window that has less left than an even pace would leave', () => {
        // 5 of 7 days left: an even pace leaves 71%; 40% is far behind.
        expect(limitPaceShortfall(weekly(60, 5), NOW)).toEqual({
            window: { windowMinutes: 10_080, usedPercent: 60, resetsAt: NOW + 5 * DAY },
            evenPacePercent: 71,
        });
    });

    it('stays quiet on pace, within the margin, for short windows, and without a reset time', () => {
        expect(limitPaceShortfall(weekly(20, 5), NOW)).toBeUndefined();
        // 71% even, 68% left: within the 5-point margin.
        expect(limitPaceShortfall(weekly(32, 5), NOW)).toBeUndefined();
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
});

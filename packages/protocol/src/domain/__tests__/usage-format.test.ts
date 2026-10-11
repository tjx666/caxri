import { describe, expect, it } from 'vitest';

import {
    formatDuration,
    formatLimitReset,
    formatLimitWindowName,
    formatPercent,
    formatTokens,
    formatUsd,
    localDateWeekday,
    shiftLocalDate,
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

    it('formats durations and ratios', () => {
        expect(formatDuration(0)).toBe('0m');
        expect(formatDuration(10_000)).toBe('<1m');
        expect(formatDuration(200 * 60_000)).toBe('3h 20m');
        expect(formatDuration(1200 * 60 * 60_000)).toBe('1,200h');
        expect(formatPercent(0.0004)).toBe('<0.1%');
        expect(formatPercent(0.054)).toBe('5.4%');
        expect(formatPercent(0.5)).toBe('50%');
    });

    it('names rate-limit windows and their reset times', () => {
        expect(formatLimitWindowName(300)).toBe('5-hour');
        expect(formatLimitWindowName(10_080)).toBe('Weekly');
        expect(formatLimitWindowName(2_880)).toBe('2-day');
        expect(formatLimitWindowName(90)).toBe('90-minute');
        expect(formatLimitReset(1_000, 2_000)).toBe('resets now');
        expect(formatLimitReset(200 * 60_000, 0)).toBe('resets in 3h 20m');
        expect(formatLimitReset(98 * 3_600_000, 0)).toBe('resets in 4d 2h');
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

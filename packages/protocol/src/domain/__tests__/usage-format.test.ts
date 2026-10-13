import { describe, expect, it } from 'vitest';

import {
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

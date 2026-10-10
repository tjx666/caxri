import { describe, expect, it } from 'vitest';

import {
    describeThroughputAggregate,
    formatThroughputDuration,
    formatThroughputRate,
    throughputRate,
} from '../agent-throughput-label';

describe('agent throughput labels', () => {
    it('weights the rate by tokens and reports nothing for an empty total', () => {
        expect(throughputRate({ durationMs: 4_000, outputTokens: 200 })).toBe(50);
        expect(throughputRate({ durationMs: 0, outputTokens: 0 })).toBeUndefined();
    });

    it('keeps one decimal only for slow rates', () => {
        expect(formatThroughputRate(8.46)).toBe('8.5 tok/s');
        expect(formatThroughputRate(47.6)).toBe('48 tok/s');
    });

    it('formats durations from tenths of a second to minutes', () => {
        expect(formatThroughputDuration(6_296)).toBe('6.3 s');
        expect(formatThroughputDuration(42_400)).toBe('42 s');
        expect(formatThroughputDuration(59_700)).toBe('1m 0s');
        expect(formatThroughputDuration(987_629)).toBe('16m 28s');
    });

    it('describes a multi-response total with its count and rate', () => {
        expect(
            describeThroughputAggregate({
                durationMs: 52_000,
                outputTokens: 3_210,
                responseCount: 12,
            }),
        ).toBe('3,210 tokens in 52 s across 12 responses · 62 tok/s');
        expect(
            describeThroughputAggregate({ durationMs: 8_600, outputTokens: 412, responseCount: 1 }),
        ).toBe('412 tokens in 8.6 s · 48 tok/s');
    });
});

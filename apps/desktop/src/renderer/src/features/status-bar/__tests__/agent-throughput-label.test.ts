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

    it('reports no rate for a duration below the timer floor', () => {
        expect(throughputRate({ durationMs: 1, outputTokens: 40 })).toBeUndefined();
        expect(throughputRate({ durationMs: 249, outputTokens: 40 })).toBeUndefined();
        expect(throughputRate({ durationMs: 250, outputTokens: 40 })).toBe(160);
        expect(
            describeThroughputAggregate({ durationMs: 1, outputTokens: 40, responseCount: 1 }),
        ).toBe('40 tokens in 0.0s');
    });

    it('rounds rates to whole tokens and shows <1 below one', () => {
        expect(formatThroughputRate(8.46)).toBe('8 tok/s');
        expect(formatThroughputRate(9.8)).toBe('10 tok/s');
        expect(formatThroughputRate(47.6)).toBe('48 tok/s');
        expect(formatThroughputRate(0.4)).toBe('<1 tok/s');
        expect(formatThroughputRate(0.9)).toBe('<1 tok/s');
        expect(formatThroughputRate(12_345.4)).toBe('12,345 tok/s');
    });

    it('formats durations from tenths of a second to minutes with flush units', () => {
        expect(formatThroughputDuration(6_296)).toBe('6.3s');
        expect(formatThroughputDuration(9_960)).toBe('10s');
        expect(formatThroughputDuration(42_400)).toBe('42s');
        expect(formatThroughputDuration(65_000)).toBe('1m 5s');
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
        ).toBe('3,210 tokens in 52s across 12 responses · 62 tok/s');
        expect(
            describeThroughputAggregate({ durationMs: 8_600, outputTokens: 412, responseCount: 1 }),
        ).toBe('412 tokens in 8.6s · 48 tok/s');
    });
});

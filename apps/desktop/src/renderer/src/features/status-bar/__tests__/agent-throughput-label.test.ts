import { describe, expect, it } from 'vitest';

import {
    describeThroughputAggregate,
    formatThroughputDuration,
    formatThroughputRate,
    isSameThroughputAggregate,
    recentAverageLabel,
    spokenThroughputRate,
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
        expect(formatThroughputRate(8.46)).toBe('8\u{A0}tok/s');
        expect(formatThroughputRate(9.8)).toBe('10\u{A0}tok/s');
        expect(formatThroughputRate(47.6)).toBe('48\u{A0}tok/s');
        expect(formatThroughputRate(0.4)).toBe('<1\u{A0}tok/s');
        expect(formatThroughputRate(0.9)).toBe('<1\u{A0}tok/s');
        expect(formatThroughputRate(12_345.4)).toBe('12,345\u{A0}tok/s');
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
        ).toBe('3,210 tokens in 52s across 12 responses · 62\u{A0}tok/s');
        expect(
            describeThroughputAggregate({ durationMs: 8_600, outputTokens: 412, responseCount: 1 }),
        ).toBe('412 tokens in 8.6s · 48\u{A0}tok/s');
    });

    it('keeps the unit on the same line as its number', () => {
        expect(formatThroughputRate(62)).not.toContain(' ');
        expect(formatThroughputRate(62)).toBe('62\u{A0}tok/s');
    });

    it('spells the rate out for accessible names', () => {
        expect(spokenThroughputRate(62.4)).toBe('62 tokens per second');
        expect(spokenThroughputRate(1.2)).toBe('1 token per second');
        expect(spokenThroughputRate(0.3)).toBe('less than 1 token per second');
    });

    it('words the headline window the same way on every surface', () => {
        expect(recentAverageLabel(10)).toBe('Average of the last 10 responses');
        expect(recentAverageLabel(1)).toBe('Last response only');
    });

    it('treats totals over the same responses as one figure', () => {
        const total = { durationMs: 52_000, outputTokens: 3_210, responseCount: 12 };
        expect(isSameThroughputAggregate(total, { ...total })).toBe(true);
        expect(isSameThroughputAggregate(total, { ...total, responseCount: 13 })).toBe(false);
    });
});

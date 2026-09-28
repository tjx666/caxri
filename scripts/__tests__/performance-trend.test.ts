import { describe, expect, it } from 'vitest';

import type { PerformanceBaseline } from '../performance-baseline';
import { derivePerformanceMetricBaseline } from '../performance-baseline';
import {
    DEFAULT_TREND_ALARM_RATIO,
    DEFAULT_TREND_WINDOW_SIZE,
    evaluatePerformanceTrend,
    formatPerformanceTrendTable,
    formatPerformanceTrendVerdict,
    TREND_ELIGIBLE_METRICS,
} from '../performance-trend';

// The same 98 real `durationMs` receipts `performance-baseline.test.ts`'s historical backtest uses, chronological
// (2026-09-24T07:13:31Z through 2026-09-28T12:48:30Z). Reused here so the trend check's window size and alarm ratio
// are exercised against real noise rather than a hand-picked distribution -- see docs/ci-performance.md's bootstrap
// analysis for the full N=20/X=2% derivation these tests summarize.
const HISTORICAL_DURATION_MS_SAMPLES = [
    211.5, 214.5, 228.5, 210.5, 211.1, 209.9, 210.4, 211.1, 213, 227.2, 211.1, 211.1, 211.1, 210.6,
    210.1, 211.1, 210, 211.6, 211.6, 211.1, 211.4, 211.6, 210.3, 209.3, 210.5, 211.3, 212.2, 210.4,
    211.4, 213, 227.7, 210.8, 209.1, 209.9, 212.3, 211.8, 214, 209.9, 228.8, 228.1, 213.2, 212.1,
    212, 211.2, 212.6, 212.6, 211.7, 211.2, 211.5, 209.1, 212.2, 212, 211.5, 217.6, 211.2, 215.9,
    216.1, 212, 194.6, 211.9, 211, 211.8, 210, 222.8, 210.2, 192, 227.5, 210.9, 197.2, 210.7, 211,
    211.7, 211.9, 211.6, 210.5, 213.4, 211.4, 210.9, 211.3, 211.3, 211.2, 211, 211.3, 228.4, 228,
    228.1, 211.7, 211.1, 211.3, 211.5, 194.8, 211.4, 194.6, 210.6, 194.8, 194.6, 194.6, 194.6,
];

function armedBaseline(): PerformanceBaseline {
    return {
        schemaVersion: 1,
        armed: true,
        source: 'runner',
        spec: 'e2e/renderer.performance.e2e.ts',
        recordedAt: '2026-01-01T00:00:00.000Z',
        commit: 'abcdef1',
        provenance: 'runs 1-98, 2026-09-24 to 2026-09-28',
        metrics: { durationMs: derivePerformanceMetricBaseline(HISTORICAL_DURATION_MS_SAMPLES) },
    };
}

describe('DEFAULT_TREND_WINDOW_SIZE and DEFAULT_TREND_ALARM_RATIO', () => {
    it('match the bootstrap-derived design documented in docs/ci-performance.md', () => {
        expect(DEFAULT_TREND_WINDOW_SIZE).toBe(20);
        expect(DEFAULT_TREND_ALARM_RATIO).toBe(0.02);
    });

    it('scopes the trend check to durationMs by default', () => {
        expect(TREND_ELIGIBLE_METRICS).toEqual(['durationMs']);
    });
});

describe('evaluatePerformanceTrend', () => {
    it('reports no-baseline when the baseline has no metrics recorded yet', () => {
        const baseline: PerformanceBaseline = { ...armedBaseline(), metrics: {} };
        expect(evaluatePerformanceTrend({}, baseline).state).toBe('no-baseline');
    });

    it('reports no-baseline for an undefined baseline (missing file)', () => {
        expect(evaluatePerformanceTrend({}, undefined).state).toBe('no-baseline');
    });

    it('never alarms an unarmed baseline no matter how large the rolling median is', () => {
        const baseline = { ...armedBaseline(), armed: false };
        const hugeWindow = Array.from({ length: 20 }, () => 10_000);
        const result = evaluatePerformanceTrend({ durationMs: hugeWindow }, baseline);
        expect(result.state).toBe('unarmed');
    });

    it('reports no-eligible-metrics when the baseline has no armed continuous entry for durationMs', () => {
        const baseline: PerformanceBaseline = {
            ...armedBaseline(),
            metrics: {
                'react.commitCount': derivePerformanceMetricBaseline([7, 8, 7, 8, 8, 7, 8, 8]),
            },
        };
        expect(evaluatePerformanceTrend({}, baseline).state).toBe('no-eligible-metrics');
    });

    it('reports insufficient-receipts when fewer than the window size of recent receipts were found', () => {
        const baseline = armedBaseline();
        const result = evaluatePerformanceTrend(
            { durationMs: HISTORICAL_DURATION_MS_SAMPLES.slice(0, 5) },
            baseline,
        );
        expect(result.state).toBe('insufficient-receipts');
    });

    it('does not alarm on a real historical 20-receipt window (noise, not creep)', () => {
        const baseline = armedBaseline();
        // The most recent 20 chronological receipts in the historical corpus, including the run of ~194.6ms
        // cold-start-looking samples at the end -- exactly the kind of window that could false-alarm a naive check.
        const recentWindow = HISTORICAL_DURATION_MS_SAMPLES.slice(-20);
        const result = evaluatePerformanceTrend({ durationMs: recentWindow }, baseline);
        expect(result.state).toBe('ok');
        expect(result.rows[0].status).toBe('ok');
    });

    it('does not alarm on any real historical 20-receipt sliding window (full sweep, not just the tail)', () => {
        const baseline = armedBaseline();
        for (
            let end = DEFAULT_TREND_WINDOW_SIZE;
            end <= HISTORICAL_DURATION_MS_SAMPLES.length;
            end += 1
        ) {
            const window = HISTORICAL_DURATION_MS_SAMPLES.slice(
                end - DEFAULT_TREND_WINDOW_SIZE,
                end,
            );
            const result = evaluatePerformanceTrend({ durationMs: window }, baseline);
            expect(result.state).toBe('ok');
        }
    });

    it('alarms when the rolling window is a sustained 3% creep over the baseline median', () => {
        const baseline = armedBaseline();
        const creepWindow = HISTORICAL_DURATION_MS_SAMPLES.slice(-DEFAULT_TREND_WINDOW_SIZE).map(
            (value) => value * 1.03,
        );
        const result = evaluatePerformanceTrend({ durationMs: creepWindow }, baseline);
        expect(result.state).toBe('alarm');
        expect(result.rows[0].status).toBe('alarm');
    });

    it('alarms when the rolling window is a sustained 5% creep over the baseline median', () => {
        const baseline = armedBaseline();
        const creepWindow = HISTORICAL_DURATION_MS_SAMPLES.slice(-DEFAULT_TREND_WINDOW_SIZE).map(
            (value) => value * 1.05,
        );
        const result = evaluatePerformanceTrend({ durationMs: creepWindow }, baseline);
        expect(result.state).toBe('alarm');
    });

    it('only uses the most recent windowSize samples when more are supplied', () => {
        const baseline = armedBaseline();
        // Prepend an extreme old value that would fail the check if it were included in the window.
        const withStaleOutlier = [
            1000,
            ...HISTORICAL_DURATION_MS_SAMPLES.slice(-DEFAULT_TREND_WINDOW_SIZE),
        ];
        const result = evaluatePerformanceTrend({ durationMs: withStaleOutlier }, baseline);
        expect(result.state).toBe('ok');
        expect(result.rows[0].sampleCount).toBe(DEFAULT_TREND_WINDOW_SIZE);
    });
});

describe('formatPerformanceTrendTable and formatPerformanceTrendVerdict', () => {
    it('marks an alarmed row and reports the ALARM verdict', () => {
        const baseline = armedBaseline();
        const creepWindow = HISTORICAL_DURATION_MS_SAMPLES.slice(-DEFAULT_TREND_WINDOW_SIZE).map(
            (value) => value * 1.05,
        );
        const result = evaluatePerformanceTrend({ durationMs: creepWindow }, baseline);
        expect(formatPerformanceTrendTable(result)).toContain('🔴 alarm');
        expect(formatPerformanceTrendVerdict(result)).toContain('ALARM');
    });

    it('reports the OK verdict distinctly from an alarm', () => {
        const baseline = armedBaseline();
        const recentWindow = HISTORICAL_DURATION_MS_SAMPLES.slice(-DEFAULT_TREND_WINDOW_SIZE);
        const result = evaluatePerformanceTrend({ durationMs: recentWindow }, baseline);
        expect(formatPerformanceTrendVerdict(result)).toContain('OK');
        expect(formatPerformanceTrendVerdict(result)).not.toContain('ALARM');
    });

    it('reports UNARMED distinctly, never as OK', () => {
        const baseline = { ...armedBaseline(), armed: false };
        const result = evaluatePerformanceTrend(
            { durationMs: HISTORICAL_DURATION_MS_SAMPLES.slice(-DEFAULT_TREND_WINDOW_SIZE) },
            baseline,
        );
        expect(formatPerformanceTrendVerdict(result)).toContain('UNARMED');
    });
});

import { describe, expect, it } from 'vitest';

import type { PerformanceBaseline } from '../performance-baseline';
import {
    comparePerformanceSamplesToBaseline,
    derivePerformanceMetricBaseline,
    extractLastBenchmarkPayload,
    flattenNumericMetrics,
    formatPerformanceGateTable,
    formatPerformanceGateVerdict,
    median,
    medianAbsoluteDeviation,
    MINIMUM_PERFORMANCE_SAMPLE_COUNT,
} from '../performance-baseline';

describe('median', () => {
    it('averages the two middle values for an even-length array', () => {
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });

    it('returns the middle value for an odd-length array', () => {
        expect(median([5, 1, 3])).toBe(3);
    });

    it('does not mutate its input', () => {
        const values = [3, 1, 2];
        median(values);
        expect(values).toEqual([3, 1, 2]);
    });

    it('throws on an empty array rather than returning a misleading number', () => {
        expect(() => median([])).toThrow();
    });
});

describe('medianAbsoluteDeviation', () => {
    it('is zero for a perfectly stable metric', () => {
        expect(medianAbsoluteDeviation([8, 8, 8, 8], 8)).toBe(0);
    });

    it('ignores a single large outlier the way a standard deviation would not', () => {
        // Nine ordinary samples cluster around 100; one blows out to 10,000. The median of the whole set barely
        // moves, and MAD around that median reports "usually within ~2 of 100", not the mean-centered aggregate a
        // stddev-based check would (whose spread this outlier alone drags well past 3,000).
        const values = [98, 99, 100, 100, 101, 102, 98, 101, 10_000];
        const center = median(values);
        expect(center).toBe(100);
        expect(medianAbsoluteDeviation(values, center)).toBeLessThan(3);
    });
});

describe('derivePerformanceMetricBaseline', () => {
    const eightCleanSamples = [48, 49, 50, 50, 51, 52, 49, 51];

    it('throws below the minimum sample count rather than deriving an unreliable threshold', () => {
        expect(() =>
            derivePerformanceMetricBaseline(
                eightCleanSamples.slice(0, MINIMUM_PERFORMANCE_SAMPLE_COUNT - 1),
            ),
        ).toThrow(/insufficient samples/u);
    });

    it('derives median + k·MAD at the minimum sample count', () => {
        const baseline = derivePerformanceMetricBaseline(eightCleanSamples, 5);
        expect(baseline.sampleCount).toBe(8);
        expect(baseline.median).toBe(50);
        expect(baseline.k).toBe(5);
        expect(baseline.thresholdMs).toBe(baseline.median + 5 * baseline.mad);
    });
});

describe('flattenNumericMetrics', () => {
    it('produces dot-path metric names for nested numeric leaves', () => {
        expect(
            flattenNumericMetrics({
                durationMs: 120,
                react: { surfaces: { workbench: { profiledRenderCount: 3 } } },
            }),
        ).toEqual({
            'durationMs': 120,
            'react.surfaces.workbench.profiledRenderCount': 3,
        });
    });

    it('skips arrays, strings, booleans, and null leaves', () => {
        expect(
            flattenNumericMetrics({
                projectListRoundTripMs: [1, 2, 3],
                executable: 'development',
                watcherErrors: 0,
                enabled: true,
                missing: null,
            }),
        ).toEqual({ watcherErrors: 0 });
    });
});

describe('extractLastBenchmarkPayload', () => {
    it('parses the last CAXRI_*_BENCHMARK line when a spec logs more than one', () => {
        const output = [
            'some unrelated log line',
            'CAXRI_RENDERER_BENCHMARK {"durationMs":100}',
            'more noise',
            'CAXRI_RENDERER_BENCHMARK {"durationMs":120}',
        ].join('\n');
        expect(extractLastBenchmarkPayload(output)).toEqual({
            marker: 'CAXRI_RENDERER_BENCHMARK',
            payload: { durationMs: 120 },
        });
    });

    it('returns undefined when the process crashed before printing its marker', () => {
        expect(extractLastBenchmarkPayload('Error: Electron failed to launch\n')).toBeUndefined();
    });
});

function armedBaseline(k = 5): PerformanceBaseline {
    // The same eight-sample distribution `derivePerformanceMetricBaseline` is exercised against above, reused so the
    // threshold here is a real derived value rather than a hand-picked number.
    const metric = derivePerformanceMetricBaseline([48, 49, 50, 50, 51, 52, 49, 51], k);
    return {
        schemaVersion: 1,
        armed: true,
        source: 'runner',
        spec: 'e2e/renderer.performance.e2e.ts',
        recordedAt: '2026-01-01T00:00:00.000Z',
        commit: 'abcdef1',
        metrics: { 'session.switch.durationMs': metric },
    };
}

describe('comparePerformanceSamplesToBaseline', () => {
    it('passes when the current run matches the sampled distribution (no injected delay)', () => {
        const baseline = armedBaseline();
        const result = comparePerformanceSamplesToBaseline(
            { 'session.switch.durationMs': baseline.metrics['session.switch.durationMs'].median },
            baseline,
        );
        expect(result.state).toBe('passed');
        expect(result.rows[0].status).toBe('ok');
    });

    it('fails when a fixed delay is injected on top of the sampled distribution', () => {
        const baseline = armedBaseline();
        const { median: baselineMedian, thresholdMs } =
            baseline.metrics['session.switch.durationMs'];
        // A fixed 500ms regression, not sampled noise: comfortably past the derived threshold regardless of k.
        const withInjectedDelay = thresholdMs + 500;
        const result = comparePerformanceSamplesToBaseline(
            { 'session.switch.durationMs': withInjectedDelay },
            baseline,
        );
        expect(result.state).toBe('failed');
        expect(result.rows[0].status).toBe('regressed');
        expect(withInjectedDelay).toBeGreaterThan(baselineMedian);
    });

    it('reports passed again once the injected delay is removed', () => {
        const baseline = armedBaseline();
        const clean = baseline.metrics['session.switch.durationMs'].median;
        const withInjectedDelay = clean + 500;
        expect(
            comparePerformanceSamplesToBaseline(
                { 'session.switch.durationMs': withInjectedDelay },
                baseline,
            ).state,
        ).toBe('failed');
        expect(
            comparePerformanceSamplesToBaseline({ 'session.switch.durationMs': clean }, baseline)
                .state,
        ).toBe('passed');
    });

    it('never fails an unarmed baseline no matter how large the regression is', () => {
        const baseline = { ...armedBaseline(), armed: false } as PerformanceBaseline;
        const hugeRegression = baseline.metrics['session.switch.durationMs'].thresholdMs + 10_000;
        const result = comparePerformanceSamplesToBaseline(
            { 'session.switch.durationMs': hugeRegression },
            baseline,
        );
        expect(result.state).toBe('unarmed');
        // The row itself still reports the regression for visibility; only the overall gate state is suppressed.
        expect(result.rows[0].status).toBe('regressed');
    });

    it('reports no-baseline when the baseline has no metrics recorded yet', () => {
        const baseline: PerformanceBaseline = {
            schemaVersion: 1,
            armed: false,
            source: 'local',
            spec: 'e2e/renderer.performance.e2e.ts',
            recordedAt: '2026-01-01T00:00:00.000Z',
            commit: 'abcdef1',
            metrics: {},
        };
        expect(comparePerformanceSamplesToBaseline({}, baseline).state).toBe('no-baseline');
    });

    it('lists a baseline metric absent from the current run instead of silently ignoring it', () => {
        const baseline = armedBaseline();
        const result = comparePerformanceSamplesToBaseline({}, baseline);
        expect(result.missingFromCurrent).toEqual(['session.switch.durationMs']);
        // Zero overlap with an armed baseline is a receipt-shape drift, not a measured comparison — it must never
        // read as a clean "passed" run (Array.prototype.some on an empty `rows` is vacuously false).
        expect(result.state).toBe('drifted');
        expect(result.rows).toEqual([]);
    });

    it('never reports drifted for an unarmed baseline even with zero overlap', () => {
        const baseline = { ...armedBaseline(), armed: false } as PerformanceBaseline;
        const result = comparePerformanceSamplesToBaseline({}, baseline);
        expect(result.state).toBe('unarmed');
    });

    it('still reports passed when only some baseline metrics are missing, not all of them', () => {
        const single = armedBaseline();
        const twoMetricBaseline: PerformanceBaseline = {
            ...single,
            metrics: {
                ...single.metrics,
                'other.metric.durationMs': single.metrics['session.switch.durationMs'],
            },
        };
        const clean = twoMetricBaseline.metrics['session.switch.durationMs'].median;
        // Only one of the two baseline metrics is present in the current run; the other is a partial, not total, drift.
        const result = comparePerformanceSamplesToBaseline(
            { 'session.switch.durationMs': clean },
            twoMetricBaseline,
        );
        expect(result.state).toBe('passed');
        expect(result.missingFromCurrent).toEqual(['other.metric.durationMs']);
    });
});

describe('formatPerformanceGateTable and formatPerformanceGateVerdict', () => {
    it('marks a regressed row and reports the failed verdict', () => {
        const baseline = armedBaseline();
        const withInjectedDelay = baseline.metrics['session.switch.durationMs'].thresholdMs + 500;
        const result = comparePerformanceSamplesToBaseline(
            { 'session.switch.durationMs': withInjectedDelay },
            baseline,
        );
        expect(formatPerformanceGateTable(result)).toContain('🔴 regressed');
        expect(formatPerformanceGateVerdict(result)).toContain('FAILED');
    });

    it('reports the unarmed verdict distinctly from a passing compare', () => {
        const baseline = { ...armedBaseline(), armed: false } as PerformanceBaseline;
        const clean = baseline.metrics['session.switch.durationMs'].median;
        const result = comparePerformanceSamplesToBaseline(
            { 'session.switch.durationMs': clean },
            baseline,
        );
        expect(formatPerformanceGateVerdict(result)).toContain('UNARMED');
        expect(formatPerformanceGateVerdict(result)).not.toContain('PASSED');
    });

    it('names the vanished metrics for a total drift instead of hiding them behind "no comparable metrics"', () => {
        const baseline = armedBaseline();
        const result = comparePerformanceSamplesToBaseline({}, baseline);
        const table = formatPerformanceGateTable(result);
        expect(table).toContain('session.switch.durationMs');
        expect(formatPerformanceGateVerdict(result)).toContain('DRIFTED');
        expect(formatPerformanceGateVerdict(result)).not.toContain('PASSED');
    });
});

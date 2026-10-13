import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { PerformanceBaseline } from '../performance-baseline';
import {
    comparePerformanceSamplesToBaseline,
    derivePerformanceMetricBaseline,
    extractLastBenchmarkPayload,
    findReceiptFiles,
    flattenNumericMetrics,
    formatPerformanceGateTable,
    formatPerformanceGateVerdict,
    isDiscretePerformanceMetric,
    isExcludedPerformanceMetric,
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

describe('isDiscretePerformanceMetric', () => {
    it('is true only when every sample is a whole number', () => {
        expect(isDiscretePerformanceMetric([7, 8, 7, 8])).toBe(true);
        expect(isDiscretePerformanceMetric([7, 8, 7.5, 8])).toBe(false);
    });

    it('is false for an empty array rather than vacuously true', () => {
        expect(isDiscretePerformanceMetric([])).toBe(false);
    });
});

describe('isExcludedPerformanceMetric', () => {
    it('excludes exactly the two baseDurationMaxMs paths whose historical corpus has the outlier problem', () => {
        expect(isExcludedPerformanceMetric('react.baseDurationMaxMs')).toBe(true);
        expect(
            isExcludedPerformanceMetric('react.surfaces.primary-sidebar.baseDurationMaxMs'),
        ).toBe(true);
    });

    it('does not exclude a baseDurationMaxMs variant whose own historical corpus has no comparable outlier', () => {
        // react.surfaces.workbench and .secondary-sidebar's baseDurationMaxMs samples top out at 3.3ms and 2.9ms in
        // the 98-receipt historical corpus -- no 11.2/15.5ms-style outlier -- so excluding them would give up real
        // regression coverage the backtest shows they do not need (0/98 leave-one-out, 0/49 time-split false
        // failures even ungated). Only the two paths with demonstrated outlier evidence are excluded.
        expect(isExcludedPerformanceMetric('react.surfaces.workbench.baseDurationMaxMs')).toBe(
            false,
        );
        expect(
            isExcludedPerformanceMetric('react.surfaces.secondary-sidebar.baseDurationMaxMs'),
        ).toBe(false);
    });

    it('does not exclude an unrelated metric or a name that merely contains the substring', () => {
        expect(isExcludedPerformanceMetric('durationMs')).toBe(false);
        expect(isExcludedPerformanceMetric('react.actualDurationMaxMs')).toBe(false);
    });

    it('excludes frames.sampleCount but keeps gating the frame metrics that are not a copy of durationMs', () => {
        expect(isExcludedPerformanceMetric('frames.sampleCount')).toBe(true);
        expect(isExcludedPerformanceMetric('frames.missedFrameCount')).toBe(false);
        expect(isExcludedPerformanceMetric('frames.maxIntervalMs')).toBe(false);
        expect(isExcludedPerformanceMetric('frames.intervalP95Ms')).toBe(false);
    });

    it('excludes the request round-trip durations but keeps gating that each request ran once', () => {
        for (const request of ['sessionSelect', 'appBootstrap']) {
            expect(isExcludedPerformanceMetric(`requests.${request}.maxDurationMs`)).toBe(true);
            expect(isExcludedPerformanceMetric(`requests.${request}.totalDurationMs`)).toBe(true);
            expect(isExcludedPerformanceMetric(`requests.${request}.count`)).toBe(false);
        }
    });
});

describe('derivePerformanceMetricBaseline', () => {
    // A realistic sub-millisecond-resolution duration sample: every value is fractional, so the whole set is
    // "continuous" regardless of how many individual values happen to round to a whole number.
    const continuousCleanSamples = [48.2, 49.1, 50.4, 50.6, 51.3, 52.1, 49.8, 51.5];
    // A realistic render-count sample: React commit counts are always whole numbers.
    const discreteCleanSamples = [7, 8, 7, 8, 8, 7, 8, 8];

    it('throws below the minimum sample count rather than deriving an unreliable threshold', () => {
        expect(() =>
            derivePerformanceMetricBaseline(
                continuousCleanSamples.slice(0, MINIMUM_PERFORMANCE_SAMPLE_COUNT - 1),
            ),
        ).toThrow(/insufficient samples/u);
    });

    it('classifies a fractional-duration sample as continuous and thresholds at the margin-padded max(median + k·MAD, historical max)', () => {
        const baseline = derivePerformanceMetricBaseline(continuousCleanSamples, { k: 5 });
        expect(baseline.kind).toBe('continuous');
        expect(baseline.sampleCount).toBe(8);
        expect(baseline.median).toBe(50.5);
        expect(baseline.k).toBe(5);
        expect(baseline.historicalMaxMs).toBe(Math.max(...continuousCleanSamples));
        const rawBase = Math.max(baseline.median + 5 * baseline.mad, baseline.historicalMaxMs);
        expect(baseline.thresholdMs).toBeCloseTo(
            rawBase * (1 + baseline.relativeMargin) + baseline.absoluteMarginMs,
            6,
        );
        expect(baseline.relativeMargin).toBeGreaterThan(0);
        expect(baseline.absoluteMarginMs).toBeGreaterThan(0);
    });

    it('classifies a whole-number sample as discrete and thresholds at the bare historical maximum, with no margin', () => {
        const baseline = derivePerformanceMetricBaseline(discreteCleanSamples);
        expect(baseline.kind).toBe('discrete');
        expect(baseline.historicalMaxMs).toBe(8);
        expect(baseline.thresholdMs).toBe(8);
        expect(baseline.relativeMargin).toBe(0);
        expect(baseline.absoluteMarginMs).toBe(0);
    });

    it('never lets a k·MAD spread override an explicit relative/absolute margin override', () => {
        const baseline = derivePerformanceMetricBaseline(continuousCleanSamples, {
            k: 5,
            relativeMargin: 0.5,
            absoluteMarginMs: 10,
        });
        expect(baseline.relativeMargin).toBe(0.5);
        expect(baseline.absoluteMarginMs).toBe(10);
    });
});

// The 98 `durationMs` values from every `renderer-performance-receipt` artifact produced by the self-hosted runner across
// recent PR CI runs (one sample per CI run, chronological, 2026-09-24T07:13:31Z through 2026-09-28T12:48:30Z). See
// docs/ci-performance.md "Per-run gate: design and backtest" for the full analysis these tests summarize: this is real,
// published CI evidence, not a synthetic distribution, because the issue this baseline gates on (#1439) was reopened
// precisely because a synthetic 8-sample design did not reflect the runner's actual noise shape.
const HISTORICAL_DURATION_MS_SAMPLES = [
    211.5, 214.5, 228.5, 210.5, 211.1, 209.9, 210.4, 211.1, 213, 227.2, 211.1, 211.1, 211.1, 210.6,
    210.1, 211.1, 210, 211.6, 211.6, 211.1, 211.4, 211.6, 210.3, 209.3, 210.5, 211.3, 212.2, 210.4,
    211.4, 213, 227.7, 210.8, 209.1, 209.9, 212.3, 211.8, 214, 209.9, 228.8, 228.1, 213.2, 212.1,
    212, 211.2, 212.6, 212.6, 211.7, 211.2, 211.5, 209.1, 212.2, 212, 211.5, 217.6, 211.2, 215.9,
    216.1, 212, 194.6, 211.9, 211, 211.8, 210, 222.8, 210.2, 192, 227.5, 210.9, 197.2, 210.7, 211,
    211.7, 211.9, 211.6, 210.5, 213.4, 211.4, 210.9, 211.3, 211.3, 211.2, 211, 211.3, 228.4, 228,
    228.1, 211.7, 211.1, 211.3, 211.5, 194.8, 211.4, 194.6, 210.6, 194.8, 194.6, 194.6, 194.6,
];

// `frames.sampleCount` from the same 98 receipts, index-aligned with `HISTORICAL_DURATION_MS_SAMPLES`.
const HISTORICAL_FRAME_SAMPLE_COUNTS = [
    12, 12, 13, 12, 12, 12, 12, 12, 12, 13, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12,
    12, 12, 12, 12, 12, 12, 13, 12, 12, 12, 12, 12, 12, 12, 13, 13, 12, 12, 12, 12, 12, 12, 12, 12,
    12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 11, 12, 12, 12, 12, 13, 12, 11, 13, 12, 11, 12, 12, 12,
    12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 13, 13, 13, 12, 12, 12, 12, 11, 12, 11, 12, 11, 11,
    11, 11,
];

/**
 * Holds out each sample in turn, derives a threshold from the rest, and counts held-out samples above it.
 */
function countLeaveOneOutFalseFailures(values: readonly number[]): number {
    let falseFailures = 0;
    for (let index = 0; index < values.length; index += 1) {
        const train = [...values.slice(0, index), ...values.slice(index + 1)];
        if (values[index] > derivePerformanceMetricBaseline(train).thresholdMs) falseFailures += 1;
    }
    return falseFailures;
}

/**
 * Derives a threshold from the older half and counts newer-half samples above it.
 */
function countTimeSplitFalseFailures(values: readonly number[]): number {
    const half = Math.floor(values.length / 2);
    const baseline = derivePerformanceMetricBaseline(values.slice(0, half));
    return values.slice(half).filter((value) => value > baseline.thresholdMs).length;
}

describe('durationMs historical backtest (real runner receipts)', () => {
    it('has a range and a MAD narrow enough that k·MAD alone would false-fail on real historical noise', () => {
        // Documents *why* the historical-max component exists: without it, median + k·MAD collapses on this
        // distribution's tight bulk and rejects its own legitimate tail. This mirrors the primary agent's original
        // backtest of the pre-redesign derivation (median 211.3, MAD 0.8 -> threshold 215.3 failed 13/98 runs).
        const center = median(HISTORICAL_DURATION_MS_SAMPLES);
        const spread = medianAbsoluteDeviation(HISTORICAL_DURATION_MS_SAMPLES, center);
        const kMadOnlyThreshold = center + 5 * spread;
        const failures = HISTORICAL_DURATION_MS_SAMPLES.filter(
            (value) => value > kMadOnlyThreshold,
        ).length;
        expect(failures).toBeGreaterThan(5);
    });

    it('derives a threshold that a leave-one-out backtest never exceeds on this historical corpus', () => {
        expect(countLeaveOneOutFalseFailures(HISTORICAL_DURATION_MS_SAMPLES)).toBe(0);
    });

    it('derives a threshold that a forward time-split backtest (older half trains, newer half evaluates) never exceeds', () => {
        expect(countTimeSplitFalseFailures(HISTORICAL_DURATION_MS_SAMPLES)).toBe(0);
    });

    it('reliably fails when a fixed 57ms delay is injected on every historical run', () => {
        const baseline = derivePerformanceMetricBaseline(HISTORICAL_DURATION_MS_SAMPLES);
        const injectedDelayMs = 57;
        const isAllCaught = HISTORICAL_DURATION_MS_SAMPLES.every(
            (value) => value + injectedDelayMs > baseline.thresholdMs,
        );
        expect(isAllCaught).toBe(true);
    });

    it('does not reliably catch a 1ms-smaller delay, showing 57ms is the smallest that catches every historical run', () => {
        const baseline = derivePerformanceMetricBaseline(HISTORICAL_DURATION_MS_SAMPLES);
        const injectedDelayMs = 56;
        const isAllCaught = HISTORICAL_DURATION_MS_SAMPLES.every(
            (value) => value + injectedDelayMs > baseline.thresholdMs,
        );
        expect(isAllCaught).toBe(false);
    });
});

describe('frames.sampleCount historical backtest (real runner receipts)', () => {
    // The runner's 60Hz display: the Renderer samples one requestAnimationFrame timestamp per vsync.
    const NOMINAL_FRAME_INTERVAL_MS = 1000 / 60;

    it('counts frame intervals over the same window durationMs measures, so it is a rounded copy of durationMs', () => {
        expect(HISTORICAL_FRAME_SAMPLE_COUNTS).toHaveLength(HISTORICAL_DURATION_MS_SAMPLES.length);
        const offsets = HISTORICAL_DURATION_MS_SAMPLES.map(
            (durationMs, index) =>
                Math.floor(durationMs / NOMINAL_FRAME_INTERVAL_MS) -
                HISTORICAL_FRAME_SAMPLE_COUNTS[index],
        );
        // Whole vsync intervals inside the window, or one fewer when the window ends before the next callback.
        expect(offsets.every((offset) => offset === 0 || offset === 1)).toBe(true);
    });

    it('passes its own backtest yet rejects windows that the backtested durationMs threshold accepts', () => {
        expect(countLeaveOneOutFalseFailures(HISTORICAL_FRAME_SAMPLE_COUNTS)).toBe(0);
        expect(countTimeSplitFalseFailures(HISTORICAL_FRAME_SAMPLE_COUNTS)).toBe(0);
        const durationBaseline = derivePerformanceMetricBaseline(HISTORICAL_DURATION_MS_SAMPLES);
        const frameBaseline = derivePerformanceMetricBaseline(HISTORICAL_FRAME_SAMPLE_COUNTS);
        expect(frameBaseline.kind).toBe('discrete');
        expect(frameBaseline.thresholdMs).toBe(13);
        // The shortest window holding one interval more than the bare-maximum frame threshold allows (~233.3ms) is
        // inside durationMs's own margin (248.104ms), so the frame count would silently re-gate durationMs more
        // strictly than its backtest supports.
        const firstRejectedWindowMs = (frameBaseline.thresholdMs + 1) * NOMINAL_FRAME_INTERVAL_MS;
        expect(firstRejectedWindowMs).toBeLessThan(durationBaseline.thresholdMs);
    });
});

describe('findReceiptFiles', () => {
    let root: string;

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('finds every matching file at any depth and ignores files with a different name', async () => {
        root = await mkdtemp(join(tmpdir(), 'caxri-performance-receipts-'));
        await mkdir(join(root, '111', 'nested'), { recursive: true });
        await mkdir(join(root, '222'), { recursive: true });
        await writeFile(join(root, '111', 'nested', 'renderer-performance.json'), '{}', 'utf8');
        await writeFile(join(root, '222', 'renderer-performance.json'), '{}', 'utf8');
        await writeFile(join(root, '222', 'other.json'), '{}', 'utf8');

        const found = (await findReceiptFiles(root)).toSorted((left, right) =>
            left.localeCompare(right),
        );
        expect(found).toEqual(
            [
                join(root, '111', 'nested', 'renderer-performance.json'),
                join(root, '222', 'renderer-performance.json'),
            ].toSorted((left, right) => left.localeCompare(right)),
        );
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
    // The same fractional eight-sample distribution `derivePerformanceMetricBaseline` is exercised against above,
    // reused so the threshold here is a real derived (continuous-kind) value rather than a hand-picked number. Every
    // value is fractional on purpose -- an all-integer sample would classify as `discrete` (see
    // `isDiscretePerformanceMetric`) and threshold at the bare historical max instead, which is not what these
    // gate-comparison tests are about.
    const metric = derivePerformanceMetricBaseline(
        [48.2, 49.1, 50.4, 50.6, 51.3, 52.1, 49.8, 51.5],
        { k },
    );
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
        // Zero overlap with an armed baseline is a receipt-shape drift, not a measured comparison: it must never
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

const committedBaseline = JSON.parse(
    await readFile(new URL('../performance-baseline.json', import.meta.url), 'utf8'),
) as PerformanceBaseline;
const historicalArmedBaseline: PerformanceBaseline = { ...committedBaseline, armed: true };

describe('committed baseline replay', () => {
    it('keeps the historical self-hosted baseline unarmed for hosted CI', () => {
        expect(committedBaseline.armed).toBe(false);
        expect(committedBaseline.provenance).toContain('self-hosted CI runs');
    });

    /**
     * A run sitting at every gated metric's committed median, except for the overrides under test.
     */
    function medianRunWith(overrides: Record<string, number>): Record<string, number> {
        const medians = Object.entries(historicalArmedBaseline.metrics).map(
            ([metric, entry]) => [metric, entry.median] as const,
        );
        return { ...Object.fromEntries(medians), ...overrides };
    }

    it('passes a 245.4ms run that stays within its durationMs threshold even though the window spans 14 frames', () => {
        // CI run 38083755666 (issue #1637): durationMs 245.4ms passed its own threshold, but frames.sampleCount 14,
        // the same window counted in vsync intervals, exceeded its bare historical maximum (13) and failed the gate.
        expect(245.4).toBeLessThanOrEqual(historicalArmedBaseline.metrics.durationMs.thresholdMs);
        const result = comparePerformanceSamplesToBaseline(
            medianRunWith({ 'durationMs': 245.4, 'frames.sampleCount': 14 }),
            historicalArmedBaseline,
        );
        expect(result.rows.filter((row) => row.status === 'regressed')).toEqual([]);
        expect(result.state).toBe('passed');
    });

    it('still fails that run once durationMs itself exceeds its threshold', () => {
        const { thresholdMs } = historicalArmedBaseline.metrics.durationMs;
        const result = comparePerformanceSamplesToBaseline(
            medianRunWith({ 'durationMs': thresholdMs + 0.1, 'frames.sampleCount': 14 }),
            historicalArmedBaseline,
        );
        expect(result.state).toBe('failed');
        expect(result.rows.find((row) => row.metric === 'durationMs')?.status).toBe('regressed');
    });

    it('passes a run whose session.select round trip took the slow 37ms mode', () => {
        // CI run 37959218557 (issue #1638): the round trip fell into its ~33ms mode on the shared runner while every
        // other metric stayed in range; a rerun of the same head can land in either mode.
        const result = comparePerformanceSamplesToBaseline(
            medianRunWith({
                'requests.sessionSelect.maxDurationMs': 37,
                'requests.sessionSelect.totalDurationMs': 37,
            }),
            historicalArmedBaseline,
        );
        expect(result.state).toBe('passed');
    });

    it('still fails a run that sent session.select twice', () => {
        const result = comparePerformanceSamplesToBaseline(
            medianRunWith({ 'requests.sessionSelect.count': 2 }),
            historicalArmedBaseline,
        );
        expect(result.state).toBe('failed');
    });

    it('gates no excluded metric and records the evidence for each exclusion', () => {
        // The gate compares only `metrics`, so an exclusion added to the code without re-deriving the committed
        // baseline would keep gating the metric it names.
        expect(Object.keys(committedBaseline.metrics).filter(isExcludedPerformanceMetric)).toEqual(
            [],
        );
        const excluded = committedBaseline.excluded ?? {};
        expect(Object.keys(excluded).every(isExcludedPerformanceMetric)).toBe(true);
        expect(excluded['frames.sampleCount']).toEqual({ historicalMaxMs: 13, sampleCount: 98 });
        expect(excluded['requests.sessionSelect.maxDurationMs']).toEqual({
            historicalMaxMs: 9.6,
            sampleCount: 98,
        });
        expect(excluded['requests.appBootstrap.maxDurationMs']).toEqual({
            historicalMaxMs: 10.3,
            sampleCount: 98,
        });
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

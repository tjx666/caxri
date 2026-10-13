/**
 * Pure logic for the gradual-creep trend check: compares a rolling window of recent `renderer-performance` runner
 * receipts against the committed baseline's median, independent of the per-run gate in
 * `scripts/performance-baseline.ts`. The per-run gate is deliberately margin-heavy (see that file's
 * `DEFAULT_PERFORMANCE_RELATIVE_MARGIN` comment) so it only catches a large, sudden regression; a steady 3-5% creep the
 * issue's motivating example describes never crosses that margin on any single run. This module catches that case by
 * comparing many runs' median against the baseline instead of one run against a per-run threshold.
 * `scripts/performance-trend-check.ts` is the CLI entrypoint a manually dispatched GitHub-hosted workflow runs; see
 * docs/ci-performance.md for the bootstrap analysis behind the constants below and how the workflow fetches receipts.
 */

import type { PerformanceBaseline } from './performance-baseline';
import { median, roundTo } from './performance-baseline';

/**
 * How many of the most recent `renderer-performance-receipt` artifacts the trend check compares its rolling median
 * against. Chosen by bootstrap-resampling the 98-receipt historical `durationMs` corpus (docs/ci-performance.md): at
 * N=20 the false-alarm rate over a 90-run simulated horizon is ~0.05% (20,000 trials) while a sustained 3% creep is
 * detected within a median of 11 runs (p95 14) and a 5% creep within a median of 10 runs (p95 12).
 */
export const DEFAULT_TREND_WINDOW_SIZE = 20;

/**
 * Alarm when the rolling window's median exceeds the committed baseline median by more than this ratio. See
 * `DEFAULT_TREND_WINDOW_SIZE`'s comment for the bootstrap that chose 2% alongside N=20.
 */
export const DEFAULT_TREND_ALARM_RATIO = 0.02;

/**
 * Metrics the trend check evaluates. Deliberately a short, explicit allowlist rather than "every continuous baseline
 * metric": the same bootstrap that chose N and X above found every other continuous metric in the historical corpus
 * either far too noisy for a percentage-based rolling-median alarm at this window size (the per-request IPC timings and
 * React `actualDuration*` metrics false-alarm 40-90% of the time at N=20/X=2%, because their sub-millisecond scale
 * amplifies rounding into double-digit percentages) or a diagnostic rather than a performance signal (the
 * frame-interval metrics track the display's refresh rate, not application work). `durationMs` -- the scenario's
 * overall wall-clock time, and the metric the issue's "steady 3% creep" example names -- is the one metric proven
 * suitable; extend this list only with the same kind of bootstrap evidence recorded in docs/ci-performance.md.
 */
export const TREND_ELIGIBLE_METRICS: readonly string[] = ['durationMs'];

// Not exported -- like `performance-baseline.ts`'s `PerformanceGateRow`/`PerformanceGateState`, these are used only
// through the exported `PerformanceTrendResult` below, and no other module imports them by name.
interface PerformanceTrendRow {
    metric: string;
    rollingMedianMs: number;
    baselineMedianMs: number;
    alarmThresholdMs: number;
    deltaPercent: number;
    sampleCount: number;
    status: 'alarm' | 'ok';
}

/**
 * `no-baseline`/`unarmed` mirror the per-run gate's states: a trend check against a baseline that cannot fail the
 * per-run gate must not fail this check either. `no-eligible-metrics` means none of `TREND_ELIGIBLE_METRICS` has a
 * continuous entry in the baseline (for example, an unarmed local baseline the operator derived with `--metrics`
 * restricted to something else). `insufficient-receipts` means fewer than the window size of recent receipts were found
 * for every eligible metric -- not yet an alarm, but also not a measured "ok".
 */
type PerformanceTrendState =
    'alarm' | 'insufficient-receipts' | 'no-baseline' | 'no-eligible-metrics' | 'ok' | 'unarmed';

export interface PerformanceTrendResult {
    state: PerformanceTrendState;
    rows: PerformanceTrendRow[];
    reason?: string;
}

export interface EvaluatePerformanceTrendOptions {
    windowSize?: number;
    alarmRatio?: number;
    eligibleMetrics?: readonly string[];
}

/**
 * `recentValuesByMetric[metric]` is expected to hold at least `windowSize` samples, one per recently fetched receipt;
 * extra samples are fine (only the most recent `windowSize`, by array order, are used) but the caller (not this
 * function) is responsible for only ever fetching genuinely recent receipts, since a median is order-independent and
 * cannot itself detect a stale or out-of-order input.
 */
export function evaluatePerformanceTrend(
    recentValuesByMetric: Readonly<Partial<Record<string, readonly number[]>>>,
    baseline: PerformanceBaseline | undefined,
    options: EvaluatePerformanceTrendOptions = {},
): PerformanceTrendResult {
    if (!baseline || Object.keys(baseline.metrics).length === 0) {
        return { state: 'no-baseline', rows: [], reason: 'baseline has no metrics recorded yet' };
    }
    if (!baseline.armed) {
        return {
            state: 'unarmed',
            rows: [],
            reason: 'baseline is not armed, see docs/ci-performance.md',
        };
    }
    const windowSize = options.windowSize ?? DEFAULT_TREND_WINDOW_SIZE;
    const alarmRatio = options.alarmRatio ?? DEFAULT_TREND_ALARM_RATIO;
    const eligibleMetrics = options.eligibleMetrics ?? TREND_ELIGIBLE_METRICS;
    const applicable = eligibleMetrics.filter(
        (metric) => baseline.metrics[metric]?.kind === 'continuous',
    );
    if (applicable.length === 0) {
        return {
            state: 'no-eligible-metrics',
            rows: [],
            reason: `none of the trend-eligible metrics (${eligibleMetrics.join(', ')}) are armed continuous baseline metrics`,
        };
    }
    const rows: PerformanceTrendRow[] = [];
    const insufficientMetrics: string[] = [];
    for (const metric of applicable) {
        const values = recentValuesByMetric[metric] ?? [];
        if (values.length < windowSize) {
            insufficientMetrics.push(`${metric} (${values.length}/${windowSize} receipt(s))`);
            continue;
        }
        const window = values.slice(-windowSize);
        const rollingMedianMs = median(window);
        const baselineMedianMs = baseline.metrics[metric].median;
        const alarmThresholdMs = roundTo(baselineMedianMs * (1 + alarmRatio), 3);
        const deltaPercent =
            baselineMedianMs === 0
                ? rollingMedianMs === 0
                    ? 0
                    : Infinity
                : roundTo(((rollingMedianMs - baselineMedianMs) / baselineMedianMs) * 100, 1);
        rows.push({
            metric,
            rollingMedianMs: roundTo(rollingMedianMs, 3),
            baselineMedianMs,
            alarmThresholdMs,
            deltaPercent,
            sampleCount: window.length,
            status: rollingMedianMs > alarmThresholdMs ? 'alarm' : 'ok',
        });
    }
    if (rows.length === 0) {
        return {
            state: 'insufficient-receipts',
            rows: [],
            reason: `fewer than the ${windowSize}-receipt window for: ${insufficientMetrics.join(', ')}`,
        };
    }
    const hasAlarm = rows.some((row) => row.status === 'alarm');
    return {
        state: hasAlarm ? 'alarm' : 'ok',
        rows,
        reason:
            insufficientMetrics.length > 0
                ? `insufficient recent receipts for: ${insufficientMetrics.join(', ')}`
                : undefined,
    };
}

function formatMs(value: number): string {
    return `${value.toFixed(2)} ms`;
}

export function formatPerformanceTrendTable(result: PerformanceTrendResult): string {
    if (result.rows.length === 0)
        return `_No comparable metrics${result.reason ? `: ${result.reason}` : ''}._\n`;
    const lines = [
        '| Metric | Rolling median (N receipts) | Baseline median | Alarm threshold | Δ vs baseline | Status |',
        '| --- | ---: | ---: | ---: | ---: | --- |',
        ...result.rows.map(
            (row) =>
                `| ${row.metric} | ${formatMs(row.rollingMedianMs)} (n=${row.sampleCount}) | ` +
                `${formatMs(row.baselineMedianMs)} | ${formatMs(row.alarmThresholdMs)} | ` +
                `${row.deltaPercent >= 0 ? '+' : ''}${row.deltaPercent.toFixed(1)}% | ` +
                `${row.status === 'alarm' ? '🔴 alarm' : '🟢 ok'} |`,
        ),
    ];
    if (result.reason) lines.push('', `_${result.reason}_`);
    return `${lines.join('\n')}\n`;
}

export function formatPerformanceTrendVerdict(result: PerformanceTrendResult): string {
    switch (result.state) {
        case 'no-baseline': {
            return `NO-BASELINE: ${result.reason ?? 'scripts/performance-baseline.json has no armed metrics yet'}`;
        }
        case 'unarmed': {
            return `UNARMED: ${result.reason ?? 'baseline is not armed'}`;
        }
        case 'no-eligible-metrics': {
            return `NO-ELIGIBLE-METRICS: ${result.reason ?? 'no trend-eligible metric is armed'}`;
        }
        case 'insufficient-receipts': {
            return `INSUFFICIENT-RECEIPTS: ${result.reason ?? 'not enough recent receipts yet'}`;
        }
        case 'ok': {
            return `OK: ${result.rows.length}/${result.rows.length} trend-eligible metric(s) within the alarm ratio`;
        }
        case 'alarm': {
            const alarmed = result.rows.filter((row) => row.status === 'alarm').length;
            return `ALARM: ${alarmed}/${result.rows.length} trend-eligible metric(s) exceeded the alarm ratio`;
        }
    }
}

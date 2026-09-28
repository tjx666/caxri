/**
 * Shared statistics and comparison logic for the performance baseline gate: deriving a noise-aware regression threshold
 * from repeated samples, flattening a benchmark receipt into comparable metrics, and comparing a current run against a
 * committed baseline. `scripts/performance-baseline-collect.ts` produces samples,
 * `scripts/performance-baseline-derive.ts` turns samples into the committed `scripts/performance-baseline.json`, and
 * `scripts/performance-baseline-gate.ts` is the CI entrypoint that uses the comparison below. See
 * `docs/ci-performance.md` for the full design and how to refresh the baseline.
 */

/**
 * Below this many samples the median absolute deviation is dominated by one or two points and is not a trustworthy
 * estimate of normal noise, so `derivePerformanceMetricBaseline` refuses to produce a threshold.
 */
export const MINIMUM_PERFORMANCE_SAMPLE_COUNT = 8;

/**
 * Multiplier applied to the median absolute deviation. 5x is deliberately generous: the goal is to catch a real,
 * repeated regression (the issue's example is a steady 3% creep per change), not to flag ordinary machine jitter on a
 * shared runner.
 */
export const DEFAULT_PERFORMANCE_THRESHOLD_K = 5;

export interface PerformanceMetricBaseline {
    median: number;
    mad: number;
    k: number;
    thresholdMs: number;
    sampleCount: number;
}

export interface PerformanceBaseline {
    schemaVersion: 1;
    /**
     * A baseline only gates a build when `armed` is true. `scripts/performance-baseline-derive.ts` hardcodes this to
     * `source === 'runner'` so a locally sampled baseline (this Mac, shared with sibling agent sessions) can never
     * silently start failing CI on the self-hosted runner it was never measured on.
     */
    armed: boolean;
    source: 'local' | 'runner';
    spec: string;
    recordedAt: string;
    commit: string;
    metrics: Record<string, PerformanceMetricBaseline>;
}

export interface PerformanceSamplesReceipt {
    schemaVersion: 1;
    spec: string;
    origin: 'ci' | 'local';
    iterations: number;
    collectedAt: string;
    commit: string;
    samples: Record<string, number[]>;
    missingSampleIterations: number;
}

type PerformanceGateRowStatus = 'ok' | 'regressed';

interface PerformanceGateRow {
    metric: string;
    currentMs: number;
    baselineMedianMs: number;
    thresholdMs: number;
    deltaPercent: number;
    status: PerformanceGateRowStatus;
}

/**
 * `unarmed`: baseline exists but was never armed (local-only, or explicitly disarmed) — recorded, never gates.
 * `no-baseline`: baseline file is missing or has no metrics yet — nothing to compare against. `skipped`: the gate
 * script decided no performance-relevant path changed; see `isPerformanceRelevantPath`. `drifted`: an armed baseline's
 * metric names have zero overlap with the current run (every one landed in `missingFromCurrent`) — a receipt-shape
 * change (renamed or restructured metrics), not a measured comparison, so it must never be reported as `passed`.
 */
type PerformanceGateState = 'drifted' | 'failed' | 'no-baseline' | 'passed' | 'skipped' | 'unarmed';

export interface PerformanceGateResult {
    state: PerformanceGateState;
    rows: PerformanceGateRow[];
    missingFromCurrent: string[];
    reason?: string;
}

function roundTo(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

export function median(values: readonly number[]): number {
    if (values.length === 0) throw new Error('median requires at least one value');
    const sorted = [...values].toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function medianAbsoluteDeviation(values: readonly number[], center: number): number {
    return median(values.map((value) => Math.abs(value - center)));
}

/**
 * Median + k·MAD threshold for one metric. Throws below `MINIMUM_PERFORMANCE_SAMPLE_COUNT` rather than returning a
 * threshold built on too little evidence — a caller that wants to skip an under-sampled metric should catch this and
 * omit it.
 */
export function derivePerformanceMetricBaseline(
    values: readonly number[],
    k: number = DEFAULT_PERFORMANCE_THRESHOLD_K,
): PerformanceMetricBaseline {
    if (values.length < MINIMUM_PERFORMANCE_SAMPLE_COUNT) {
        throw new Error(
            `insufficient samples (${values.length}) to derive a threshold; need at least ${MINIMUM_PERFORMANCE_SAMPLE_COUNT}`,
        );
    }
    const centerValue = median(values);
    const spread = medianAbsoluteDeviation(values, centerValue);
    return {
        median: roundTo(centerValue, 3),
        mad: roundTo(spread, 3),
        k,
        thresholdMs: roundTo(centerValue + k * spread, 3),
        sampleCount: values.length,
    };
}

/**
 * Recursively collects numeric leaf values from a benchmark receipt into dot-path metric names (for example
 * `react.surfaces.workbench.actualDurationTotalMs`). Arrays are skipped rather than flattened: a metric like
 * `projectListRoundTripMs` is a repeated-sample array whose length and per-index meaning are not stable across runs, so
 * there is no single dot-path that would keep comparing the same thing.
 */
export function flattenNumericMetrics(value: unknown, prefix = ''): Record<string, number> {
    if (typeof value === 'number')
        return prefix && Number.isFinite(value) ? { [prefix]: value } : {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const output: Record<string, number> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        Object.assign(output, flattenNumericMetrics(nested, prefix ? `${prefix}.${key}` : key));
    }
    return output;
}

const BENCHMARK_MARKER_PATTERN = /^(CAXRI_[A-Z_]+_BENCHMARK) (\{.*\})$/gmu;

/**
 * Finds every `CAXRI_*_BENCHMARK {...}` line a performance E2E spec prints (see `e2e/*.performance.e2e.ts`) and returns
 * the last one, matching how the spec itself treats the line as its authoritative result. Returns `undefined` when no
 * such line is present, for example when the process crashed before reaching it.
 */
export function extractLastBenchmarkPayload(
    output: string,
): { marker: string; payload: Record<string, unknown> } | undefined {
    const matches = output.matchAll(BENCHMARK_MARKER_PATTERN).toArray();
    const last = matches.at(-1);
    if (!last) return undefined;
    try {
        return { marker: last[1], payload: JSON.parse(last[2]) as Record<string, unknown> };
    } catch {
        return undefined;
    }
}

/**
 * Compares one run's flattened metrics against a committed baseline. Every metric the baseline knows about is reported;
 * a metric the current receipt no longer has (a renamed or removed field) is listed in `missingFromCurrent` rather than
 * silently ignored, since that is itself a receipt-shape drift worth surfacing.
 */
export function comparePerformanceSamplesToBaseline(
    current: Readonly<Partial<Record<string, number>>>,
    baseline: PerformanceBaseline,
): PerformanceGateResult {
    const metricNames = Object.keys(baseline.metrics);
    if (metricNames.length === 0) {
        return {
            state: 'no-baseline',
            rows: [],
            missingFromCurrent: [],
            reason: 'baseline has no metrics recorded yet',
        };
    }
    const rows: PerformanceGateRow[] = [];
    const missingFromCurrent: string[] = [];
    for (const metric of metricNames) {
        const currentMs = current[metric];
        if (currentMs === undefined) {
            missingFromCurrent.push(metric);
            continue;
        }
        const { median: baselineMedianMs, thresholdMs } = baseline.metrics[metric];
        const deltaPercent =
            baselineMedianMs === 0
                ? currentMs === 0
                    ? 0
                    : Infinity
                : ((currentMs - baselineMedianMs) / baselineMedianMs) * 100;
        rows.push({
            metric,
            currentMs,
            baselineMedianMs,
            thresholdMs,
            deltaPercent: roundTo(deltaPercent, 1),
            status: currentMs > thresholdMs ? 'regressed' : 'ok',
        });
    }
    const hasRegression = rows.some((row) => row.status === 'regressed');
    // Zero overlap between the baseline's metric names and the current run means nothing was actually compared — an
    // empty `rows.some(...)` is vacuously `false`, which would otherwise read as "passed". Report it as its own
    // `drifted` state instead so a receipt-shape rename can never look like a clean run.
    const isTotalDrift = rows.length === 0;
    let state: PerformanceGateState;
    if (!baseline.armed) {
        state = 'unarmed';
    } else if (isTotalDrift) {
        state = 'drifted';
    } else {
        state = hasRegression ? 'failed' : 'passed';
    }
    return { state, rows, missingFromCurrent };
}

function formatMs(value: number): string {
    return `${value.toFixed(2)} ms`;
}

/**
 * Readable before/after table for the job log and step summary. Kept as Markdown so it renders directly in the GitHub
 * Actions step summary as well as a terminal.
 */
export function formatPerformanceGateTable(result: PerformanceGateResult): string {
    if (result.rows.length === 0) {
        // Rows can be empty either because there was nothing to compare (no baseline metrics) or because every
        // baseline metric is missing from the current run (`drifted`, see `comparePerformanceSamplesToBaseline`). The
        // second case must still name the vanished metrics rather than reuse the generic "nothing to compare" line,
        // or the step summary would look identical to a harmless no-baseline run.
        if (result.missingFromCurrent.length === 0) return '_No comparable metrics._\n';
        return (
            `_No comparable metrics: every baseline metric is missing from the current run: ` +
            `${result.missingFromCurrent.join(', ')}._\n`
        );
    }
    const lines = [
        '| Metric | Current | Baseline median | Threshold (median + k·MAD) | Δ vs baseline | Status |',
        '| --- | ---: | ---: | ---: | ---: | --- |',
        ...result.rows.map(
            (row) =>
                `| ${row.metric} | ${formatMs(row.currentMs)} | ${formatMs(row.baselineMedianMs)} | ` +
                `${formatMs(row.thresholdMs)} | ${row.deltaPercent >= 0 ? '+' : ''}${row.deltaPercent.toFixed(1)}% | ` +
                `${row.status === 'regressed' ? '🔴 regressed' : '🟢 ok'} |`,
        ),
    ];
    if (result.missingFromCurrent.length > 0) {
        lines.push(
            '',
            `_Baseline metrics missing from the current run: ${result.missingFromCurrent.join(', ')}._`,
        );
    }
    return `${lines.join('\n')}\n`;
}

export function formatPerformanceGateVerdict(result: PerformanceGateResult): string {
    switch (result.state) {
        case 'skipped': {
            return `SKIPPED — ${result.reason ?? 'no performance-relevant path changed'}`;
        }
        case 'no-baseline': {
            return `NO-BASELINE — ${result.reason ?? 'scripts/performance-baseline.json has no armed metrics yet'}`;
        }
        case 'unarmed': {
            return `UNARMED — recorded ${result.rows.length} metric(s); baseline is not armed, see docs/ci-performance.md`;
        }
        case 'passed': {
            return `PASSED — ${result.rows.length}/${result.rows.length} metric(s) within threshold`;
        }
        case 'failed': {
            const regressed = result.rows.filter((row) => row.status === 'regressed').length;
            return `FAILED — ${regressed}/${result.rows.length} metric(s) exceeded their threshold`;
        }
        case 'drifted': {
            return (
                `DRIFTED — none of the ${result.missingFromCurrent.length} armed baseline metric(s) were found in ` +
                `the current run; re-derive scripts/performance-baseline.json, see docs/ci-performance.md`
            );
        }
    }
}

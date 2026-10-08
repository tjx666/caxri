/**
 * Shared statistics and comparison logic for the performance baseline gate: deriving a noise-aware regression threshold
 * from repeated samples, flattening a benchmark receipt into comparable metrics, and comparing a current run against a
 * committed baseline. `scripts/performance-baseline-collect.ts` produces samples,
 * `scripts/performance-baseline-derive.ts` turns samples into the committed `scripts/performance-baseline.json`, and
 * `scripts/performance-baseline-gate.ts` is the CI entrypoint that uses the comparison below.
 * `scripts/performance-trend.ts` builds on the same `median`/`roundTo` primitives for the separate gradual-creep check.
 * See `docs/ci-performance.md` for the full design and how to refresh the baseline.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Recursively finds every file named exactly `filename` under `rootPath`. Recursion is manual (not `readdir(..., {
 * recursive: true })`) so a symlink inside a downloaded artifact directory is never followed twice -- matching the same
 * concern `scripts/ci-bundle-budget.ts`'s `measureBytes` documents. Used to collect `renderer-performance.json`
 * receipts out of a `gh run download` / artifacts directory for `scripts/performance-baseline-derive.ts --input-dir`
 * and `scripts/performance-trend-check.ts --receipts-dir`.
 */
export async function findReceiptFiles(
    rootPath: string,
    filename = 'renderer-performance.json',
): Promise<string[]> {
    const entries = await readdir(rootPath, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
        const entryPath = join(rootPath, entry.name);
        if (entry.isDirectory()) {
            // eslint-disable-next-line no-await-in-loop -- a receipts directory is at most a few hundred entries deep
            found.push(...(await findReceiptFiles(entryPath, filename)));
        } else if (entry.isFile() && entry.name === filename) {
            found.push(entryPath);
        }
    }
    return found;
}

/**
 * Below this many samples the median absolute deviation is dominated by one or two points and is not a trustworthy
 * estimate of normal noise, so `derivePerformanceMetricBaseline` refuses to produce a threshold.
 */
export const MINIMUM_PERFORMANCE_SAMPLE_COUNT = 8;

/**
 * Below this many samples a _continuous_ metric's `max(values)` is not a trustworthy estimate of the true historical
 * tail either -- `docs/ci-performance.md`'s backtest used 98 real runner receipts and only reached a 0% false-failure
 * rate at that scale. `scripts/performance-baseline-derive.ts` still derives below this count (down to
 * `MINIMUM_PERFORMANCE_SAMPLE_COUNT`), it only warns, because a first-time arming has no larger corpus to draw from.
 */
export const RECOMMENDED_MINIMUM_RUNNER_SAMPLE_COUNT = 40;

/**
 * Multiplier applied to the median absolute deviation. 5x is deliberately generous: the goal is to catch a real,
 * repeated regression (the issue's example is a steady 3% creep per change), not to flag ordinary machine jitter on a
 * shared runner.
 */
export const DEFAULT_PERFORMANCE_THRESHOLD_K = 5;

/**
 * Multiplicative margin applied on top of `max(median + k·MAD, historicalMax)` for a continuous metric. Backtested
 * against 98 real `renderer-performance` runner receipts (see docs/ci-performance.md "Per-run gate: design and
 * backtest"): `k·MAD` alone collapses on this distribution (the bulk of samples cluster within a fraction of a
 * millisecond of the median while a legitimate noise tail reaches several percent further out), so the threshold is
 * anchored to the observed historical maximum instead and this margin absorbs the chance that the next clean run's
 * maximum lands slightly past every one already seen. 8% plus `DEFAULT_PERFORMANCE_ABSOLUTE_MARGIN_MS` was the smallest
 * combination that reached a 0% false-failure rate on both the leave-one-out and time-split backtests.
 */
export const DEFAULT_PERFORMANCE_RELATIVE_MARGIN = 0.08;

/**
 * Flat additive margin (in the metric's own unit -- milliseconds for every gated metric) applied after the relative
 * margin. Alone, a percentage margin is too tight on a near-zero metric (8% of 0.3ms is 0.024ms, smaller than the
 * receipt's own 0.1ms rounding), so this floor keeps small-scale metrics from re-arming on their own rounding noise.
 */
export const DEFAULT_PERFORMANCE_ABSOLUTE_MARGIN_MS = 1;

/**
 * Exact metric names excluded from the per-run gate and the trend check even when a receipt reports them. Recorded in
 * the committed baseline's `excluded` map (see `PerformanceBaseline`) for auditability, never compared.
 * `react.baseDurationMaxMs` and `react.surfaces.primary-sidebar.baseDurationMaxMs` estimate the render cost React
 * _would have_ paid without memoization on the app's heaviest surface; the 98-receipt historical corpus contains two
 * outliers (11.2ms and 15.5ms against a 3.4-6.8ms bulk) on exactly these two paths that no plausible margin absorbs
 * without also hiding a real regression of similar size (1/98 leave-one-out and 2/49 time-split false failures even
 * with the margin applied) -- see docs/ci-performance.md for the backtest that found them.
 *
 * This is deliberately an exact-name list rather than a blanket `baseDurationMaxMs` pattern: the same backtest run
 * against `react.surfaces.workbench.baseDurationMaxMs` and `react.surfaces.secondary-sidebar.baseDurationMaxMs` --
 * which have no comparable outliers (max 3.3ms and 2.9ms respectively) -- found 0/98 leave-one-out and 0/49 time-split
 * false failures without any exclusion, so those two stay gated. Add another name here only with the same kind of
 * per-metric backtest evidence; this is a documented, narrow exception, not a place to route every noisy metric or
 * every variant of a noisy metric's family.
 */
const EXCLUDED_PERFORMANCE_METRIC_NAMES = new Set([
    'react.baseDurationMaxMs',
    'react.surfaces.primary-sidebar.baseDurationMaxMs',
]);

export function isExcludedPerformanceMetric(metric: string): boolean {
    return EXCLUDED_PERFORMANCE_METRIC_NAMES.has(metric);
}

/**
 * A metric is treated as discrete (render/commit counts, and any duration metric the platform itself quantizes to whole
 * milliseconds, such as the Event Timing API's `interactions.maxDurationMs`) when every sample in the derivation window
 * happens to be a whole number. This is deliberately shape-based rather than name-based: a dot-path allowlist of
 * "count" names would miss `interactions.maxDurationMs`, which is a genuine duration but reads as one of only four
 * values (16/24/32/40) because the browser rounds it -- exactly the "frame-quantized metric" case
 * `docs/ci-performance.md` documents needing the historical-max treatment instead of median + k·MAD. Real
 * `performance.now()`-based millisecond durations (`durationMs`, `react.actualDurationP95Ms`, ...) have never landed on
 * a whole number across every sample in the 98-receipt historical corpus, so this heuristic does not misclassify them
 * there; a future metric that manages to do so only affects that one metric's threshold shape, not the others.
 */
export function isDiscretePerformanceMetric(values: readonly number[]): boolean {
    return values.length > 0 && values.every((value) => Number.isSafeInteger(value));
}

export interface PerformanceMetricBaseline {
    kind: 'continuous' | 'discrete';
    median: number;
    mad: number;
    k: number;
    /**
     * 0 for a discrete metric -- its threshold is the bare historical maximum, see `derivePerformanceMetricBaseline`.
     */
    relativeMargin: number;
    /**
     * 0 for a discrete metric.
     */
    absoluteMarginMs: number;
    /**
     * Raw `max(values)` from the derivation window, kept alongside `thresholdMs` for auditability.
     */
    historicalMaxMs: number;
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
    /**
     * Free-text description of the runner receipts this baseline was derived from -- an artifact/run id range and a
     * date range, matching `docs/ci-performance.md`'s arming recipe. Never a local filesystem path: the receipts are
     * downloaded into an operator-chosen temp directory that must not end up in a committed, eventually-public file.
     * Present only for `source: 'runner'` derivations; `--source local` never writes it.
     */
    provenance?: string;
    metrics: Record<string, PerformanceMetricBaseline>;
    /**
     * Metrics `isExcludedPerformanceMetric` matched during derivation, keyed by dot-path name, with the raw sample
     * evidence that justified excluding each one. Never gated or trend-checked, but written here (rather than only to
     * the derive command's console output) so a contributor reading the committed file -- the only artifact that
     * survives past that one-time command -- can audit which metrics were deliberately left out and why, without
     * re-running the derivation. Absent, or an empty object, when no metric was excluded from a given derivation.
     */
    excluded?: Record<string, { historicalMaxMs: number; sampleCount: number }>;
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
    kind: 'continuous' | 'discrete';
    currentMs: number;
    baselineMedianMs: number;
    thresholdMs: number;
    deltaPercent: number;
    status: PerformanceGateRowStatus;
}

/**
 * `unarmed`: baseline exists but was never armed (local-only, or explicitly disarmed): recorded, never gates.
 * `no-baseline`: baseline file is missing or has no metrics yet: nothing to compare against. `skipped`: the gate script
 * decided no performance-relevant path changed; see `isPerformanceRelevantPath`. `drifted`: an armed baseline's metric
 * names have zero overlap with the current run (every one landed in `missingFromCurrent`), a receipt-shape change
 * (renamed or restructured metrics), not a measured comparison, so it must never be reported as `passed`.
 */
type PerformanceGateState = 'drifted' | 'failed' | 'no-baseline' | 'passed' | 'skipped' | 'unarmed';

export interface PerformanceGateResult {
    state: PerformanceGateState;
    rows: PerformanceGateRow[];
    missingFromCurrent: string[];
    reason?: string;
}

export function roundTo(value: number, decimals: number): number {
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

export interface DerivePerformanceMetricBaselineOptions {
    /**
     * Multiplier on the median absolute deviation, see `DEFAULT_PERFORMANCE_THRESHOLD_K`.
     */
    k?: number;
    /**
     * See `DEFAULT_PERFORMANCE_RELATIVE_MARGIN`. Ignored for a discrete metric.
     */
    relativeMargin?: number;
    /**
     * See `DEFAULT_PERFORMANCE_ABSOLUTE_MARGIN_MS`. Ignored for a discrete metric.
     */
    absoluteMarginMs?: number;
}

/**
 * Derives one metric's gate threshold from repeated samples. Throws below `MINIMUM_PERFORMANCE_SAMPLE_COUNT` rather
 * than returning a threshold built on too little evidence, a caller that wants to skip an under-sampled metric should
 * catch this and omit it.
 *
 * `isDiscretePerformanceMetric` decides the shape:
 *
 * - Discrete (render/commit counts, frame-quantized durations): `thresholdMs` is the bare historical maximum. There is no
 *   margin, so an intended increase (a new count that is genuinely supposed to be higher) requires an explicit baseline
 *   refresh rather than silently widening on its own next time it is sampled.
 * - Continuous (ordinary sub-millisecond-resolution durations): `thresholdMs` is `max(median + k·MAD, historicalMax) * (1
 *
 *   - RelativeMargin) + absoluteMarginMs`. `k·MAD`alone is a real spread estimate but collapses on a distribution whose
 *       bulk sits far tighter than its legitimate tail (see`DEFAULT_PERFORMANCE_RELATIVE_MARGIN`'s comment); anchoring
 *       to the historical maximum instead, with a margin to absorb the next clean run landing slightly past every one
 *       already seen, is what reached a 0% false-failure rate in the backtest documented in docs/ci-performance.md.
 */
export function derivePerformanceMetricBaseline(
    values: readonly number[],
    options: DerivePerformanceMetricBaselineOptions = {},
): PerformanceMetricBaseline {
    if (values.length < MINIMUM_PERFORMANCE_SAMPLE_COUNT) {
        throw new Error(
            `insufficient samples (${values.length}) to derive a threshold; need at least ${MINIMUM_PERFORMANCE_SAMPLE_COUNT}`,
        );
    }
    const k = options.k ?? DEFAULT_PERFORMANCE_THRESHOLD_K;
    const centerValue = median(values);
    const spread = medianAbsoluteDeviation(values, centerValue);
    const historicalMax = Math.max(...values);
    const isDiscrete = isDiscretePerformanceMetric(values);
    const relativeMargin = isDiscrete
        ? 0
        : (options.relativeMargin ?? DEFAULT_PERFORMANCE_RELATIVE_MARGIN);
    const absoluteMarginMs = isDiscrete
        ? 0
        : (options.absoluteMarginMs ?? DEFAULT_PERFORMANCE_ABSOLUTE_MARGIN_MS);
    const thresholdMs = isDiscrete
        ? historicalMax
        : Math.max(centerValue + k * spread, historicalMax) * (1 + relativeMargin) +
          absoluteMarginMs;
    return {
        kind: isDiscrete ? 'discrete' : 'continuous',
        median: roundTo(centerValue, 3),
        mad: roundTo(spread, 3),
        k,
        relativeMargin,
        absoluteMarginMs,
        historicalMaxMs: roundTo(historicalMax, 3),
        thresholdMs: roundTo(thresholdMs, 3),
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
        const { kind, median: baselineMedianMs, thresholdMs } = baseline.metrics[metric];
        const deltaPercent =
            baselineMedianMs === 0
                ? currentMs === 0
                    ? 0
                    : Infinity
                : ((currentMs - baselineMedianMs) / baselineMedianMs) * 100;
        rows.push({
            metric,
            kind,
            currentMs,
            baselineMedianMs,
            thresholdMs,
            deltaPercent: roundTo(deltaPercent, 1),
            status: currentMs > thresholdMs ? 'regressed' : 'ok',
        });
    }
    const hasRegression = rows.some((row) => row.status === 'regressed');
    // Zero overlap between the baseline's metric names and the current run means nothing was actually compared, an
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
        '| Metric | Kind | Current | Baseline median | Threshold | Δ vs baseline | Status |',
        '| --- | --- | ---: | ---: | ---: | ---: | --- |',
        ...result.rows.map(
            (row) =>
                `| ${row.metric} | ${row.kind} | ${formatMs(row.currentMs)} | ${formatMs(row.baselineMedianMs)} | ` +
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
            return `SKIPPED: ${result.reason ?? 'no performance-relevant path changed'}`;
        }
        case 'no-baseline': {
            return `NO-BASELINE: ${result.reason ?? 'scripts/performance-baseline.json has no armed metrics yet'}`;
        }
        case 'unarmed': {
            return `UNARMED: recorded ${result.rows.length} metric(s); baseline is not armed, see docs/ci-performance.md`;
        }
        case 'passed': {
            return `PASSED: ${result.rows.length}/${result.rows.length} metric(s) within threshold`;
        }
        case 'failed': {
            const regressed = result.rows.filter((row) => row.status === 'regressed').length;
            return `FAILED: ${regressed}/${result.rows.length} metric(s) exceeded their threshold`;
        }
        case 'drifted': {
            return (
                `DRIFTED: none of the ${result.missingFromCurrent.length} armed baseline metric(s) were found in ` +
                `the current run; re-derive scripts/performance-baseline.json, see docs/ci-performance.md`
            );
        }
    }
}

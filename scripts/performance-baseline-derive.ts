/**
 * Derives (or refreshes) the committed `scripts/performance-baseline.json` from one or more sample inputs, using
 * `derivePerformanceMetricBaseline` (see scripts/performance-baseline.ts for the median + k·MAD / historical-max design
 * and docs/ci-performance.md for the full backtest). Refreshing the baseline is always this explicit, reviewable
 * command: nothing writes `scripts/performance-baseline.json` implicitly.
 *
 * Each `--input` is one of:
 *
 * - A samples receipt written by `scripts/performance-baseline-collect.ts` (has a top-level `samples` object of arrays),
 *   or
 * - A single benchmark receipt such as `test-results/receipts/renderer-performance.json` (one CI run's numbers),
 *   contributing exactly one sample per metric.
 *
 * `--input` is repeatable (one file per flag). `--input-dir` is the ergonomic alternative for arming from many
 * downloaded runner receipts at once: it recursively finds every `renderer-performance.json` under the given directory
 * (matching the layout `gh run download <run-id> --name renderer-performance-receipt --dir <dir>` produces, one receipt
 * per downloaded run) and adds each as an input. `--input` and `--input-dir` are both repeatable and can be combined.
 *
 * `--source local` always writes `armed: false`: a Mac sampled locally, shared with sibling agent sessions, is evidence
 * for the statistical method, never a stand-in for the self-hosted CI runner's own noise. `--source runner` requires
 * `--provenance` (a short free-text description of which artifacts this came from: run id range and dates, never a
 * local path, see docs/ci-performance.md's arming recipe for how to compute it).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec';
import type { PerformanceBaseline, PerformanceSamplesReceipt } from './performance-baseline';
import {
    DEFAULT_PERFORMANCE_ABSOLUTE_MARGIN_MS,
    DEFAULT_PERFORMANCE_RELATIVE_MARGIN,
    DEFAULT_PERFORMANCE_THRESHOLD_K,
    derivePerformanceMetricBaseline,
    findReceiptFiles,
    flattenNumericMetrics,
    isExcludedPerformanceMetric,
    MINIMUM_PERFORMANCE_SAMPLE_COUNT,
    RECOMMENDED_MINIMUM_RUNNER_SAMPLE_COUNT,
} from './performance-baseline';

export interface CliOptions {
    absoluteMarginMs: number;
    inputDirs: string[];
    inputs: string[];
    k: number;
    metrics?: string[];
    out: string;
    provenance?: string;
    relativeMargin: number;
    source: 'local' | 'runner';
    spec: string;
}

function applyDeriveFlag(options: CliOptions, flag: string, value: string | undefined): void {
    switch (flag) {
        case '--input': {
            if (!value) throw new Error('--input requires a value');
            options.inputs.push(value);
            break;
        }
        case '--input-dir': {
            if (!value) throw new Error('--input-dir requires a value');
            options.inputDirs.push(value);
            break;
        }
        case '--out': {
            if (!value) throw new Error('--out requires a value');
            options.out = value;
            break;
        }
        case '--source': {
            if (value !== 'local' && value !== 'runner') {
                throw new Error('--source must be "local" or "runner"');
            }
            options.source = value;
            break;
        }
        case '--spec': {
            if (!value) throw new Error('--spec requires a value');
            options.spec = value;
            break;
        }
        case '--k': {
            if (!value) throw new Error('--k requires a value');
            options.k = Number(value);
            break;
        }
        case '--relative-margin': {
            if (!value) throw new Error('--relative-margin requires a value');
            options.relativeMargin = Number(value);
            break;
        }
        case '--absolute-margin-ms': {
            if (!value) throw new Error('--absolute-margin-ms requires a value');
            options.absoluteMarginMs = Number(value);
            break;
        }
        case '--provenance': {
            if (!value) throw new Error('--provenance requires a value');
            options.provenance = value;
            break;
        }
        case '--metrics': {
            if (!value) throw new Error('--metrics requires a comma-separated value');
            options.metrics = value.split(',').map((metric) => metric.trim());
            break;
        }
        default: {
            throw new Error(`Unknown argument: ${flag}`);
        }
    }
}

export function parseArguments(argv: string[]): CliOptions {
    const options: CliOptions = {
        absoluteMarginMs: DEFAULT_PERFORMANCE_ABSOLUTE_MARGIN_MS,
        inputDirs: [],
        inputs: [],
        k: DEFAULT_PERFORMANCE_THRESHOLD_K,
        out: 'scripts/performance-baseline.json',
        relativeMargin: DEFAULT_PERFORMANCE_RELATIVE_MARGIN,
        source: 'local',
        spec: '',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        applyDeriveFlag(options, flag, value);
        index += 1;
    }
    if (options.inputs.length === 0 && options.inputDirs.length === 0) {
        throw new Error('At least one --input or --input-dir is required');
    }
    if (!options.spec) throw new Error('--spec is required');
    if (!Number.isFinite(options.k) || options.k <= 0)
        throw new Error('--k must be a positive number');
    if (!Number.isFinite(options.relativeMargin) || options.relativeMargin < 0)
        throw new Error('--relative-margin must be a non-negative number');
    if (!Number.isFinite(options.absoluteMarginMs) || options.absoluteMarginMs < 0)
        throw new Error('--absolute-margin-ms must be a non-negative number');
    if (options.source === 'runner' && !options.provenance) {
        throw new Error(
            '--provenance is required for --source runner (see docs/ci-performance.md for what to record)',
        );
    }
    return options;
}

export function isSamplesReceipt(value: unknown): value is PerformanceSamplesReceipt {
    return (
        typeof value === 'object' &&
        value !== null &&
        'samples' in value &&
        typeof (value as { samples?: unknown }).samples === 'object'
    );
}

/**
 * Merges every input's contribution into one `metric -> values[]` map. A samples receipt contributes its whole arrays;
 * a single-run receipt contributes exactly one value per metric it has.
 */
async function collectContributions(
    inputPaths: readonly string[],
): Promise<Partial<Record<string, number[]>>> {
    const contributions: Partial<Record<string, number[]>> = {};
    for (const inputPath of inputPaths) {
        // Inputs are read in order so a malformed file names itself in the thrown error; the count is small enough
        // that serial reads cost nothing worth parallelizing for.
        // eslint-disable-next-line no-await-in-loop -- see above
        const raw = await readFile(resolve(inputPath), 'utf8');
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            throw new Error(
                `${inputPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
                {
                    cause: error,
                },
            );
        }
        if (isSamplesReceipt(parsed)) {
            for (const [metric, values] of Object.entries(parsed.samples)) {
                (contributions[metric] ??= []).push(...values);
            }
        } else {
            const flattened = flattenNumericMetrics(parsed);
            for (const [metric, value] of Object.entries(flattened)) {
                (contributions[metric] ??= []).push(value);
            }
        }
    }
    return contributions;
}

export async function resolveInputPaths(options: CliOptions): Promise<string[]> {
    const fromDirectories = await Promise.all(
        options.inputDirs.map((directory) => findReceiptFiles(directory)),
    );
    const flattenedFromDirectories = fromDirectories.flat();
    if (options.inputDirs.length > 0 && flattenedFromDirectories.length === 0) {
        throw new Error(
            `--input-dir found no renderer-performance.json under: ${options.inputDirs.join(', ')}`,
        );
    }
    return [...options.inputs, ...flattenedFromDirectories];
}

async function currentCommit(): Promise<string> {
    try {
        return (await execFileAsync('git', ['rev-parse', 'HEAD'])).stdout.trim();
    } catch {
        return 'unknown';
    }
}

export interface DerivedPerformanceMetrics {
    metrics: Record<string, ReturnType<typeof derivePerformanceMetricBaseline>>;
    /**
     * Same metric names as the keys of `excludedMetrics`, kept as a separate ordered list purely for the console
     * summary's `join(', ')`.
     */
    excluded: string[];
    /**
     * Raw sample evidence for each excluded metric, written verbatim into `PerformanceBaseline.excluded` -- see that
     * field's doc comment for why this must survive into the committed file rather than only this command's stdout.
     */
    excludedMetrics: Record<string, { historicalMaxMs: number; sampleCount: number }>;
    skipped: string[];
    underSampled: string[];
}

/**
 * Pure classification step shared by `main` and its tests: sorts every contributed metric into gated, excluded (with
 * evidence), skipped (too few samples), or under-sampled-but-armed-anyway, and derives a threshold for every gated one.
 * Split out from `main` so this decision logic -- in particular that an excluded metric's evidence reaches
 * `excludedMetrics` -- has a narrower, IO-free surface to test than the full CLI.
 */
export function derivePerformanceMetrics(
    contributions: Partial<Record<string, number[]>>,
    options: Pick<CliOptions, 'absoluteMarginMs' | 'k' | 'metrics' | 'relativeMargin' | 'source'>,
): DerivedPerformanceMetrics {
    const selectedMetrics = options.metrics ?? Object.keys(contributions);
    const metrics: Record<string, ReturnType<typeof derivePerformanceMetricBaseline>> = {};
    const skipped: string[] = [];
    const excluded: string[] = [];
    const excludedMetrics: Record<string, { historicalMaxMs: number; sampleCount: number }> = {};
    const underSampled: string[] = [];
    for (const metric of selectedMetrics) {
        if (!options.metrics && isExcludedPerformanceMetric(metric)) {
            excluded.push(metric);
            const excludedValues = contributions[metric];
            if (excludedValues && excludedValues.length > 0) {
                excludedMetrics[metric] = {
                    historicalMaxMs: Math.max(...excludedValues),
                    sampleCount: excludedValues.length,
                };
            }
            continue;
        }
        const values = contributions[metric];
        if (!values || values.length < MINIMUM_PERFORMANCE_SAMPLE_COUNT) {
            skipped.push(`${metric} (${values?.length ?? 0} sample(s))`);
            continue;
        }
        if (
            options.source === 'runner' &&
            values.length < RECOMMENDED_MINIMUM_RUNNER_SAMPLE_COUNT
        ) {
            underSampled.push(`${metric} (${values.length} sample(s))`);
        }
        metrics[metric] = derivePerformanceMetricBaseline(values, {
            k: options.k,
            relativeMargin: options.relativeMargin,
            absoluteMarginMs: options.absoluteMarginMs,
        });
    }
    return { metrics, excluded, excludedMetrics, skipped, underSampled };
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const inputPaths = await resolveInputPaths(options);
    const contributions = await collectContributions(inputPaths);
    const { metrics, excluded, excludedMetrics, skipped, underSampled } = derivePerformanceMetrics(
        contributions,
        options,
    );
    if (excluded.length > 0) {
        console.log(
            `[performance-baseline-derive] excluded ${excluded.length} metric(s) from gating (see isExcludedPerformanceMetric): ${excluded.join(', ')}`,
        );
    }
    if (skipped.length > 0) {
        console.warn(
            `[performance-baseline-derive] skipped ${skipped.length} metric(s) below the ${MINIMUM_PERFORMANCE_SAMPLE_COUNT}-sample minimum: ${skipped.join(', ')}`,
        );
    }
    if (underSampled.length > 0) {
        console.warn(
            `[performance-baseline-derive] ${underSampled.length} metric(s) armed below the recommended ` +
                `${RECOMMENDED_MINIMUM_RUNNER_SAMPLE_COUNT}-sample runner corpus (docs/ci-performance.md's backtest used ` +
                `98 receipts); the historical-max component of their threshold is less trustworthy until more runner ` +
                `receipts accumulate: ${underSampled.join(', ')}`,
        );
    }
    if (Object.keys(metrics).length === 0) {
        throw new Error(
            `No metric reached the ${MINIMUM_PERFORMANCE_SAMPLE_COUNT}-sample minimum; collect more runs before deriving a baseline.`,
        );
    }
    const baseline: PerformanceBaseline = {
        schemaVersion: 1,
        armed: options.source === 'runner',
        source: options.source,
        spec: options.spec,
        recordedAt: new Date().toISOString(),
        commit: await currentCommit(),
        ...(options.provenance && { provenance: options.provenance }),
        metrics,
        ...(Object.keys(excludedMetrics).length > 0 && { excluded: excludedMetrics }),
    };
    const outPath = resolve(options.out);
    await writeFile(outPath, `${JSON.stringify(baseline, undefined, 4)}\n`, 'utf8');
    console.log(
        `CAXRI_PERF_BASELINE_DERIVED ${JSON.stringify({
            armed: baseline.armed,
            source: baseline.source,
            metricCount: Object.keys(metrics).length,
            excludedCount: excluded.length,
            skippedCount: skipped.length,
            out: options.out,
        })}`,
    );
}

if (import.meta.main) await main();

/**
 * Derives (or refreshes) the committed `scripts/performance-baseline.json` from one or more sample inputs, using
 * `derivePerformanceMetricBaseline` (median + k·MAD, see scripts/performance-baseline.ts). Refreshing the baseline is
 * always this explicit, reviewable command — nothing writes `scripts/performance-baseline.json` implicitly.
 *
 * Each `--input` is one of:
 *
 * - A samples receipt written by `scripts/performance-baseline-collect.ts` (has a top-level `samples` object of arrays),
 *   or
 * - A single benchmark receipt such as `test-results/receipts/renderer-performance.json` (one CI run's numbers),
 *   contributing exactly one sample per metric.
 *
 * Multiple inputs are merged; `--input` is repeatable (one file per flag — the shell does not glob-expand a single
 * `--input pattern*.json` into that shape), so seeding from CI-produced samples looks like the recipe documented in
 * docs/ci-performance.md: download every green run's `renderer-performance-receipt` artifact, then pass each downloaded
 * JSON file as its own `--input` alongside `--source runner`.
 *
 * `--source local` always writes `armed: false`: a Mac sampled locally, shared with sibling agent sessions, is evidence
 * for the statistical method, never a stand-in for the self-hosted CI runner's own noise.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec';
import type { PerformanceBaseline, PerformanceSamplesReceipt } from './performance-baseline';
import {
    DEFAULT_PERFORMANCE_THRESHOLD_K,
    derivePerformanceMetricBaseline,
    flattenNumericMetrics,
    MINIMUM_PERFORMANCE_SAMPLE_COUNT,
} from './performance-baseline';

export interface CliOptions {
    inputs: string[];
    k: number;
    metrics?: string[];
    out: string;
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
        inputs: [],
        k: DEFAULT_PERFORMANCE_THRESHOLD_K,
        out: 'scripts/performance-baseline.json',
        source: 'local',
        spec: '',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        applyDeriveFlag(options, flag, value);
        index += 1;
    }
    if (options.inputs.length === 0) throw new Error('At least one --input is required');
    if (!options.spec) throw new Error('--spec is required');
    if (!Number.isFinite(options.k) || options.k <= 0)
        throw new Error('--k must be a positive number');
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

async function currentCommit(): Promise<string> {
    try {
        return (await execFileAsync('git', ['rev-parse', 'HEAD'])).stdout.trim();
    } catch {
        return 'unknown';
    }
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const contributions = await collectContributions(options.inputs);
    const selectedMetrics = options.metrics ?? Object.keys(contributions);
    const metrics: Record<string, ReturnType<typeof derivePerformanceMetricBaseline>> = {};
    const skipped: string[] = [];
    for (const metric of selectedMetrics) {
        const values = contributions[metric];
        if (!values || values.length < MINIMUM_PERFORMANCE_SAMPLE_COUNT) {
            skipped.push(`${metric} (${values?.length ?? 0} sample(s))`);
            continue;
        }
        metrics[metric] = derivePerformanceMetricBaseline(values, options.k);
    }
    if (skipped.length > 0) {
        console.warn(
            `[performance-baseline-derive] skipped ${skipped.length} metric(s) below the ${MINIMUM_PERFORMANCE_SAMPLE_COUNT}-sample minimum: ${skipped.join(', ')}`,
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
        metrics,
    };
    const outPath = resolve(options.out);
    await writeFile(outPath, `${JSON.stringify(baseline, undefined, 4)}\n`, 'utf8');
    console.log(
        `CAXRI_PERF_BASELINE_DERIVED ${JSON.stringify({
            armed: baseline.armed,
            source: baseline.source,
            metricCount: Object.keys(metrics).length,
            skippedCount: skipped.length,
            out: options.out,
        })}`,
    );
}

if (import.meta.main) await main();

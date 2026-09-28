/**
 * CI entrypoint for the performance baseline gate: compares one already-produced benchmark receipt (or a locally
 * collected samples receipt) against the committed `scripts/performance-baseline.json` and fails with a readable
 * before/after table when a metric's current value exceeds its median + k·MAD threshold. See docs/ci-performance.md for
 * the full design, including why an unarmed or missing baseline records rather than silently passing.
 *
 * Usage in CI, after `bun run benchmark:renderer` has written its receipt: `bun run performance:baseline:gate --
 * --receipt test-results/receipts/renderer-performance.json --baseline scripts/performance-baseline.json`.
 *
 * Usage locally, comparing a repeated-sample collection instead of one run: `bun run performance:baseline:gate --
 * --samples test-results/receipts/performance-baseline-samples.json --baseline scripts/performance-baseline.json`.
 *
 * `CI_CHANGED_FILES` (a JSON array of repository-relative paths, matching the shape `scripts/ci-retry-policy.ts`
 * already writes for `needs.retry-policy.outputs.changed_files`) gates the comparison to performance-relevant paths in
 * CI only; a non-empty list with no relevant path present exits 0 with a `skipped` verdict instead of comparing. Local
 * invocations without that env var always compare — an operator running this by hand wants a real answer, not a skip.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { isPerformanceRelevantPath } from './ci-path-policy';
import type {
    PerformanceBaseline,
    PerformanceGateResult,
    PerformanceSamplesReceipt,
} from './performance-baseline';
import {
    comparePerformanceSamplesToBaseline,
    flattenNumericMetrics,
    formatPerformanceGateTable,
    formatPerformanceGateVerdict,
    median,
} from './performance-baseline';

export type CliOptions = { baseline: string } & (
    { current: string; mode: 'receipt' } | { current: string; mode: 'samples' }
);

interface RawCliFlags {
    baseline?: string;
    receipt?: string;
    samples?: string;
}

function applyGateFlag(flags: RawCliFlags, flag: string, value: string | undefined): void {
    switch (flag) {
        case '--baseline': {
            if (!value) throw new Error('--baseline requires a value');
            flags.baseline = value;
            break;
        }
        case '--receipt': {
            if (!value) throw new Error('--receipt requires a value');
            flags.receipt = value;
            break;
        }
        case '--samples': {
            if (!value) throw new Error('--samples requires a value');
            flags.samples = value;
            break;
        }
        default: {
            throw new Error(`Unknown argument: ${flag}`);
        }
    }
}

export function parseArguments(argv: string[]): CliOptions {
    const flags: RawCliFlags = {};
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        applyGateFlag(flags, flag, value);
        index += 1;
    }
    const { baseline, receipt, samples } = flags;
    if (!baseline) throw new Error('--baseline is required');
    if (receipt && samples) throw new Error('--receipt and --samples are mutually exclusive');
    if (receipt) return { baseline, current: receipt, mode: 'receipt' };
    if (samples) return { baseline, current: samples, mode: 'samples' };
    throw new Error('One of --receipt or --samples is required');
}

/**
 * Decides whether the current CI job's changed files touch a performance-relevant path. Returns `false` (meaning
 * "always compare") outside CI, or in CI when there is no changed-files signal to reason about at all — an empty or
 * missing list is not positive evidence that nothing relevant changed, so the gate defaults to running rather than
 * defaults to skipping.
 */
export function shouldSkipForChangedFiles(): boolean {
    if (process.env.GITHUB_ACTIONS !== 'true') return false;
    const raw = process.env.CI_CHANGED_FILES;
    if (!raw) return false;
    let changedFiles: unknown;
    try {
        changedFiles = JSON.parse(raw);
    } catch {
        // A malformed value is a bug in the caller, not evidence either way; fail closed to "compare" so a broken
        // signal can never accidentally suppress a real regression check.
        return false;
    }
    if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
    return changedFiles.every(
        (path) => !(typeof path === 'string' && isPerformanceRelevantPath(path)),
    );
}

async function readBaseline(path: string): Promise<PerformanceBaseline | undefined> {
    try {
        return JSON.parse(await readFile(resolve(path), 'utf8')) as PerformanceBaseline;
    } catch {
        return undefined;
    }
}

async function currentMetricsFromReceipt(path: string): Promise<Record<string, number>> {
    const parsed: unknown = JSON.parse(await readFile(resolve(path), 'utf8'));
    return flattenNumericMetrics(parsed);
}

async function currentMetricsFromSamples(path: string): Promise<Record<string, number>> {
    const receipt = JSON.parse(await readFile(resolve(path), 'utf8')) as PerformanceSamplesReceipt;
    const current: Record<string, number> = {};
    for (const [metric, values] of Object.entries(receipt.samples)) {
        if (values.length > 0) current[metric] = median(values);
    }
    return current;
}

async function writeSummary(markdown: string): Promise<void> {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;
    await appendFile(summaryPath, markdown, 'utf8');
}

async function main(): Promise<void> {
    if (shouldSkipForChangedFiles()) {
        const result: PerformanceGateResult = {
            state: 'skipped',
            rows: [],
            missingFromCurrent: [],
            reason: 'no changed file matched isPerformanceRelevantPath',
        };
        console.log(`CAXRI_PERF_GATE ${JSON.stringify(result)}`);
        console.log(formatPerformanceGateVerdict(result));
        await writeSummary(
            `### Performance baseline gate\n\n${formatPerformanceGateVerdict(result)}\n`,
        );
        return;
    }

    const options = parseArguments(process.argv.slice(2));
    const baseline = await readBaseline(options.baseline);
    const current =
        options.mode === 'receipt'
            ? await currentMetricsFromReceipt(options.current)
            : await currentMetricsFromSamples(options.current);

    const result: PerformanceGateResult = baseline
        ? comparePerformanceSamplesToBaseline(current, baseline)
        : {
              state: 'no-baseline',
              rows: [],
              missingFromCurrent: [],
              reason: `${options.baseline} does not exist yet`,
          };

    console.log(`CAXRI_PERF_GATE ${JSON.stringify(result)}`);
    console.log(formatPerformanceGateVerdict(result));
    console.log(formatPerformanceGateTable(result));
    await writeSummary(
        `### Performance baseline gate\n\n${formatPerformanceGateVerdict(result)}\n\n${formatPerformanceGateTable(result)}`,
    );

    if (result.state === 'failed') {
        process.exitCode = 1;
    }
}

if (import.meta.main) await main();

/**
 * CLI entrypoint for the gradual-creep trend check: reads a directory of already-downloaded `renderer-performance.json`
 * receipts (one per recent runner CI run) and `scripts/performance-baseline.json`, then reports
 * `scripts/performance-trend.ts`'s verdict as a step summary table and a non-zero exit code on alarm.
 *
 * This is a lightweight GitHub-hosted-runner tool: fetching artifacts through the REST API and comparing two small JSON
 * structures needs no macOS runner or Electron build. The design goal (see docs/ci-performance.md) is to keep the
 * gradual-creep check out of the required PR guards. `.github/workflows/performance-trend.yml` is the only caller: it
 * downloads the most recent `renderer-performance-receipt` artifacts with `gh run download` into `--receipts-dir`
 * before invoking this script.
 *
 * Usage: `bun run performance:trend:check -- --baseline scripts/performance-baseline.json --receipts-dir
 * /tmp/performance-trend-receipts`. `--window` and `--alarm-ratio` default to
 * `DEFAULT_TREND_WINDOW_SIZE`/`DEFAULT_TREND_ALARM_RATIO` and only need overriding for recalibration.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import type { PerformanceBaseline } from './performance-baseline';
import { findReceiptFiles, flattenNumericMetrics } from './performance-baseline';
import {
    DEFAULT_TREND_ALARM_RATIO,
    DEFAULT_TREND_WINDOW_SIZE,
    evaluatePerformanceTrend,
    formatPerformanceTrendTable,
    formatPerformanceTrendVerdict,
    TREND_ELIGIBLE_METRICS,
} from './performance-trend';

export interface CliOptions {
    alarmRatio: number;
    baseline: string;
    metrics: readonly string[];
    receiptsDir: string;
    windowSize: number;
}

function applyTrendFlag(options: CliOptions, flag: string, value: string | undefined): void {
    switch (flag) {
        case '--baseline': {
            if (!value) throw new Error('--baseline requires a value');
            options.baseline = value;
            break;
        }
        case '--receipts-dir': {
            if (!value) throw new Error('--receipts-dir requires a value');
            options.receiptsDir = value;
            break;
        }
        case '--window': {
            if (!value) throw new Error('--window requires a value');
            options.windowSize = Number(value);
            break;
        }
        case '--alarm-ratio': {
            if (!value) throw new Error('--alarm-ratio requires a value');
            options.alarmRatio = Number(value);
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
        alarmRatio: DEFAULT_TREND_ALARM_RATIO,
        baseline: 'scripts/performance-baseline.json',
        metrics: TREND_ELIGIBLE_METRICS,
        receiptsDir: '',
        windowSize: DEFAULT_TREND_WINDOW_SIZE,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        applyTrendFlag(options, flag, value);
        index += 1;
    }
    if (!options.receiptsDir) throw new Error('--receipts-dir is required');
    if (!Number.isSafeInteger(options.windowSize) || options.windowSize < 1) {
        throw new Error('--window must be a positive integer');
    }
    if (!Number.isFinite(options.alarmRatio) || options.alarmRatio <= 0) {
        throw new Error('--alarm-ratio must be a positive number');
    }
    return options;
}

async function readBaseline(path: string): Promise<PerformanceBaseline | undefined> {
    try {
        return JSON.parse(await readFile(resolve(path), 'utf8')) as PerformanceBaseline;
    } catch {
        return undefined;
    }
}

/**
 * Reads every `renderer-performance.json` receipt under `receiptsDir` and collects each eligible metric's values.
 * Receipt order does not matter: `evaluatePerformanceTrend` only computes a median over whatever is handed to it, so
 * "recent" is entirely the responsibility of the caller that populated `receiptsDir` (the workflow's `gh run download`
 * step, which fetches the N most recently created matching artifacts).
 */
async function readRecentValues(
    receiptsDirectory: string,
    metrics: readonly string[],
): Promise<Record<string, number[]>> {
    const receiptPaths = await findReceiptFiles(resolve(receiptsDirectory));
    const recentValuesByMetric: Record<string, number[]> = Object.fromEntries(
        metrics.map((metric) => [metric, []]),
    );
    for (const receiptPath of receiptPaths) {
        // eslint-disable-next-line no-await-in-loop -- a trend window is a few dozen small JSON files at most
        const parsed: unknown = JSON.parse(await readFile(receiptPath, 'utf8'));
        const flattened = flattenNumericMetrics(parsed);
        for (const metric of metrics) {
            // `metric in flattened` (not `flattened[metric] !== undefined`) because `flattenNumericMetrics` returns
            // `Record<string, number>`: without `noUncheckedIndexedAccess`, TypeScript sees `flattened[metric]` as
            // always `number`, so an undefined-value check reads as dead code even though a given receipt can
            // genuinely be missing this metric (an older receipt shape, or one that excluded it).
            if (metric in flattened) recentValuesByMetric[metric].push(flattened[metric]);
        }
    }
    return recentValuesByMetric;
}

async function writeSummary(markdown: string): Promise<void> {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;
    await appendFile(summaryPath, markdown, 'utf8');
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const baseline = await readBaseline(options.baseline);
    const recentValuesByMetric = await readRecentValues(options.receiptsDir, options.metrics);

    const result = evaluatePerformanceTrend(recentValuesByMetric, baseline, {
        windowSize: options.windowSize,
        alarmRatio: options.alarmRatio,
        eligibleMetrics: options.metrics,
    });

    console.log(`CAXRI_PERF_TREND ${JSON.stringify(result)}`);
    console.log(formatPerformanceTrendVerdict(result));
    console.log(formatPerformanceTrendTable(result));
    await writeSummary(
        `### Performance gradual-creep trend check\n\n${formatPerformanceTrendVerdict(result)}\n\n${formatPerformanceTrendTable(result)}`,
    );

    if (result.state === 'alarm') {
        process.exitCode = 1;
    }
}

if (import.meta.main) await main();

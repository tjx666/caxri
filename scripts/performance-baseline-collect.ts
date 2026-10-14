/**
 * Runs one performance E2E spec N times and records every run's flattened metrics as raw samples. This is the "collect
 * noise" step of the baseline design in docs/ci-performance.md: it never derives a threshold or writes the committed
 * baseline itself, so re-running it is always safe.
 *
 * Usage: bun run performance:baseline:collect -- --spec e2e/renderer.performance.e2e.ts --iterations 10\
 * --env CAXRI_RENDERER_BENCHMARK=1 --env CAXRI_E2E_OUTPUT_DIR=test-results/renderer-performance\
 * --out test-results/receipts/performance-baseline-samples.json
 *
 * The Renderer scenario needs a profiling build first (`CAXRI_REACT_PROFILING=1 bun run build`); the startup scenario
 * needs `CAXRI_BENCHMARK_PROJECT_ROOT` pointed at a representative repository and an ordinary `bun run build`. This
 * script does not build for you, so a stale bundle measures the wrong code: build immediately before collecting.
 */

import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync, waitForChildExit } from './exec';
import type { PerformanceSamplesReceipt } from './performance-baseline';
import { extractLastBenchmarkPayload, flattenNumericMetrics } from './performance-baseline';

export interface CliOptions {
    env: Record<string, string>;
    iterations: number;
    out: string;
    spec: string;
}

function applyCollectFlag(options: CliOptions, flag: string, value: string | undefined): void {
    switch (flag) {
        case '--spec': {
            if (!value) throw new Error('--spec requires a value');
            options.spec = value;
            break;
        }
        case '--iterations': {
            if (!value) throw new Error('--iterations requires a value');
            options.iterations = Number(value);
            break;
        }
        case '--out': {
            if (!value) throw new Error('--out requires a value');
            options.out = value;
            break;
        }
        case '--env': {
            if (!value || !value.includes('=')) throw new Error('--env requires KEY=VALUE');
            const [key, ...rest] = value.split('=');
            options.env[key] = rest.join('=');
            break;
        }
        default: {
            throw new Error(`Unknown argument: ${flag}`);
        }
    }
}

export function parseArguments(argv: string[]): CliOptions {
    const options: CliOptions = {
        env: {},
        iterations: 10,
        out: 'test-results/receipts/performance-baseline-samples.json',
        spec: '',
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = argv[index + 1];
        applyCollectFlag(options, flag, value);
        index += 1;
    }
    if (!options.spec)
        throw new Error('Usage: performance-baseline-collect --spec <e2e spec path> [options]');
    if (!Number.isSafeInteger(options.iterations) || options.iterations < 1) {
        throw new Error('--iterations must be a positive integer');
    }
    return options;
}

async function runOnce(spec: string, environment: Record<string, string>): Promise<string> {
    const childEnvironment = { ...process.env, ...environment };
    const child = spawn('bunx', ['playwright', 'test', spec], {
        env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    // Waits for 'close' rather than 'exit' so every buffered stdout/stderr chunk has been delivered to the listeners
    // above before this returns. The exit code itself is informational only: every performance spec prints its
    // `CAXRI_*_BENCHMARK` line before its threshold assertions run, so a spec that fails an assertion still yields a
    // usable sample. Only a genuinely missing marker (crash before that point) is treated as a missed iteration below.
    await waitForChildExit(child, { event: 'close' });
    return output;
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
    const samples: Record<string, number[]> = {};
    let missingSampleIterations = 0;
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
        process.stdout.write(
            `[performance-baseline-collect] iteration ${iteration}/${options.iterations}: ${options.spec}\n`,
        );
        // Iterations must run serially: each one launches its own Electron instance under the same desktop lease, and
        // a concurrent second launch would contend for the same resources it is trying to measure.
        // eslint-disable-next-line no-await-in-loop -- see above
        const output = await runOnce(options.spec, options.env);
        const extracted = extractLastBenchmarkPayload(output);
        if (!extracted) {
            missingSampleIterations += 1;
            const tail = output.split('\n').filter(Boolean).slice(-20).join('\n');
            process.stderr.write(
                `[performance-baseline-collect] iteration ${iteration} produced no CAXRI_*_BENCHMARK line; last output:\n${tail}\n`,
            );
            continue;
        }
        const flattened = flattenNumericMetrics(extracted.payload);
        for (const [metric, value] of Object.entries(flattened)) {
            (samples[metric] ??= []).push(value);
        }
    }
    const receipt: PerformanceSamplesReceipt = {
        schemaVersion: 1,
        spec: options.spec,
        origin: process.env.GITHUB_ACTIONS === 'true' ? 'ci' : 'local',
        iterations: options.iterations,
        collectedAt: new Date().toISOString(),
        commit: await currentCommit(),
        samples,
        missingSampleIterations,
    };
    const outPath = resolve(options.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(receipt, undefined, 2)}\n`, 'utf8');
    const metricCount = Object.keys(samples).length;
    console.log(
        `CAXRI_PERF_BASELINE_SAMPLES ${JSON.stringify({
            spec: options.spec,
            iterations: options.iterations,
            metricCount,
            missingSampleIterations,
            out: options.out,
        })}`,
    );
    if (metricCount === 0) {
        throw new Error(
            'No metrics were collected; every iteration was missing its benchmark line.',
        );
    }
}

if (import.meta.main) await main();

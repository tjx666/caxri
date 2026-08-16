#!/usr/bin/env bun

/**
 * CI bundle budget gate: performs a timed production build and a timed macOS dir packaging pass, then fails when any
 * tracked artifact grows past its byte budget or either phase exceeds its wall-time budget. Budgets are absolute
 * ceilings with headroom above the optimized baseline recorded in docs/bundle-size.md — regressions that eat the
 * headroom must either be optimized away or consciously re-budgeted in the same PR that introduces them.
 */

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MiB = 1_024 * 1_024;

interface SizeBudget {
    /**
     * Repository-relative path of the file or directory the budget covers.
     */
    path: string;
    maxBytes: number;
}

interface TimeBudget {
    label: string;
    maxSeconds: number;
    command: string[];
}

/**
 * Byte ceilings for every packaged artifact this repository ships. Baseline (2026-08): out/main ≈ 2.5 MiB, out/preload
 * ≈ 12 KiB, out/renderer ≈ 31 MiB, app.asar ≈ 34 MiB, app.asar.unpacked ≈ 6 MiB, Caxri.app ≈ 272 MiB.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export const SIZE_BUDGETS: SizeBudget[] = [
    { path: 'out/main', maxBytes: 4 * MiB },
    { path: 'out/preload', maxBytes: 256 * 1_024 },
    { path: 'out/renderer', maxBytes: 34 * MiB },
    { path: 'release/mac-arm64/Caxri.app/Contents/Resources/app.asar', maxBytes: 38 * MiB },
    { path: 'release/mac-arm64/Caxri.app/Contents/Resources/app.asar.unpacked', maxBytes: 8 * MiB },
    { path: 'release/mac-arm64/Caxri.app', maxBytes: 290 * MiB },
];

/**
 * Wall-time ceilings guard against toolchain regressions (for example accidentally enabling source maps or analysis
 * plugins on every build) rather than machine noise, so they carry generous headroom over the self-hosted baseline
 * (build ≈ 10 s, package ≈ 35 s).
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export const TIME_BUDGETS: TimeBudget[] = [
    { label: 'build', maxSeconds: 180, command: ['bun', 'run', 'build'] },
    {
        label: 'package',
        maxSeconds: 300,
        command: ['./node_modules/.bin/electron-builder', '--mac', 'dir'],
    },
];

interface Measurement {
    label: string;
    actual: number;
    budget: number;
    unit: 'bytes' | 'seconds';
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function findBudgetViolations(measurements: Measurement[]): Measurement[] {
    return measurements.filter((measurement) => measurement.actual > measurement.budget);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function formatMeasurement(measurement: Measurement): string {
    const format = (value: number): string =>
        measurement.unit === 'bytes' ? `${(value / MiB).toFixed(2)} MiB` : `${value.toFixed(1)} s`;
    const status = measurement.actual > measurement.budget ? 'OVER BUDGET' : 'ok';
    return `${measurement.label}: ${format(measurement.actual)} (budget ${format(measurement.budget)}) ${status}`;
}

/**
 * Logical byte size of a file or directory tree. Uses file sizes rather than disk blocks so the gate is deterministic
 * across filesystems and block sizes. Recursion is manual because macOS framework bundles contain `Versions/Current`
 * directory symlinks that `readdir` with `recursive: true` would traverse, double-counting the Electron framework;
 * dirent type checks never follow symlinks, so each real file is counted exactly once.
 */
async function measureBytes(targetPath: string): Promise<number> {
    const target = await stat(targetPath);
    if (!target.isDirectory()) return target.size;
    const entries = await readdir(targetPath, { withFileTypes: true });
    const sizes = await Promise.all(
        entries.map(async (entry) => {
            const entryPath = join(targetPath, entry.name);
            if (entry.isDirectory()) return measureBytes(entryPath);
            if (!entry.isFile()) return 0;
            const fileStat = await stat(entryPath);
            return fileStat.size;
        }),
    );
    let total = 0;
    for (const size of sizes) total += size;
    return total;
}

/**
 * Node-executable entry points inside the packaged asar. Loading them with `ELECTRON_RUN_AS_NODE` proves every
 * bundler-visible and bundler-invisible `require` resolves inside the package — exactly the regression class that
 * dependency rearrangement can introduce (a dep moved to `devDependencies` while some code still requires it externally
 * at runtime). Each entry is expected to fail fast on missing process wiring, not on module resolution.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export const PACKAGED_NODE_ENTRIES = ['out/main/host.js', 'out/main/runtime.js'];

const PACKAGED_EXECUTABLE = 'release/mac-arm64/Caxri.app/Contents/MacOS/Caxri';
const PACKAGED_ASAR = 'release/mac-arm64/Caxri.app/Contents/Resources/app.asar';

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-bundle-budget.test.ts
export function findModuleResolutionFailure(stderr: string): string | undefined {
    const match = /Cannot find (?:module|package) '[^']+'/u.exec(stderr);
    return match?.[0];
}

async function verifyPackagedModuleResolution(): Promise<string[]> {
    const failures: string[] = [];
    for (const entry of PACKAGED_NODE_ENTRIES) {
        let stderr = '';
        try {
            // The entry is expected to exit non-zero on missing env wiring; only the stderr matters.
            // eslint-disable-next-line no-await-in-loop -- serial keeps the packaged binary contention-free
            await execFileAsync(
                resolve(PACKAGED_EXECUTABLE),
                [join(resolve(PACKAGED_ASAR), entry)],
                {
                    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                    timeout: 30_000,
                },
            );
        } catch (error) {
            stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
        }
        const failure = findModuleResolutionFailure(stderr);
        if (failure) failures.push(`${entry}: ${failure}`);
    }
    return failures;
}

async function runTimed(budget: TimeBudget): Promise<number> {
    const startedAt = performance.now();
    const [command, ...arguments_] = budget.command;
    const child = spawn(command, arguments_, { stdio: 'inherit' });
    // `once` rejects when the child emits 'error' (e.g. missing binary) before exiting.
    const [exitCode] = (await once(child, 'exit')) as [number | null];
    if (exitCode !== 0) {
        throw new Error(`${budget.label} command failed with exit code ${exitCode}`);
    }
    return (performance.now() - startedAt) / 1_000;
}

async function main(): Promise<void> {
    // Stale packaging output would otherwise contaminate the size measurements below.
    await rm(resolve('release'), { recursive: true, force: true });

    const measurements: Measurement[] = [];
    for (const timeBudget of TIME_BUDGETS) {
        // Build must complete before packaging starts; the loop order encodes that dependency.
        // eslint-disable-next-line no-await-in-loop -- intentionally sequential phases
        const elapsedSeconds = await runTimed(timeBudget);
        measurements.push({
            label: `${timeBudget.label} time`,
            actual: elapsedSeconds,
            budget: timeBudget.maxSeconds,
            unit: 'seconds',
        });
    }

    const sizeMeasurements = await Promise.all(
        SIZE_BUDGETS.map(async (sizeBudget) => ({
            label: sizeBudget.path,
            actual: await measureBytes(resolve(sizeBudget.path)),
            budget: sizeBudget.maxBytes,
            unit: 'bytes' as const,
        })),
    );
    measurements.push(...sizeMeasurements);

    for (const measurement of measurements) {
        const receipt = {
            actual: Number(measurement.actual.toFixed(measurement.unit === 'bytes' ? 0 : 3)),
            budget: measurement.budget,
            label: measurement.label,
            unit: measurement.unit,
        };
        console.log(`CAXRI_BUNDLE_BUDGET ${JSON.stringify(receipt)}`);
        console.log(formatMeasurement(measurement));
    }

    const resolutionFailures = await verifyPackagedModuleResolution();
    if (resolutionFailures.length > 0) {
        console.error('\nPackaged module resolution failed:');
        for (const failure of resolutionFailures) console.error(`  - ${failure}`);
        console.error(
            '\nA runtime dependency is missing from the package. Either bundle it (keep it in ' +
                'devDependencies with a bundler-visible import) or ship it in production dependencies.',
        );
        process.exit(1);
    }
    console.log('Packaged module resolution ok.');

    const violations = findBudgetViolations(measurements);
    if (violations.length > 0) {
        console.error(`\nBundle budget gate failed (${violations.length} violation(s)):`);
        for (const violation of violations) console.error(`  - ${formatMeasurement(violation)}`);
        console.error(
            '\nEither optimize the regression away or consciously raise the budget in ' +
                'scripts/ci-bundle-budget.ts and docs/bundle-size.md within the same PR.',
        );
        process.exit(1);
    }
    console.log('\nBundle budget gate passed.');
}

if (import.meta.main) {
    await main();
}

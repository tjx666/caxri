#!/usr/bin/env bun

import { access } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import process from 'node:process';

import type { CIChecksScope } from './ci-execution-plan';
import { printNodeCrashReports } from './crash-report-summary';
import { runChildProcess } from './exec';

const projectRoot = resolve(import.meta.dirname, '..');

const RELATED_SOURCE_EXTENSIONS = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const SHARD_PATTERN = /^([1-9]\d*)\/([1-9]\d*)$/u;

/**
 * `vitest related` follows the whole import graph, so a change deep in a shared package still reaches every suite that
 * transitively imports it: the direct-import heuristic `check --test` uses would miss those.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by its test and quality-check's `check --related`
export function affectedTestArguments(paths: readonly string[]): string[] | undefined {
    const sources = paths.filter((path) => RELATED_SOURCE_EXTENSIONS.test(path));
    if (sources.length === 0) return undefined;
    return ['vitest', 'related', '--run', '--passWithNoTests', '--silent=passed-only', ...sources];
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-unit-tests.test.ts
export function parseShard(value: string | undefined): string {
    const match = SHARD_PATTERN.exec(value ?? '');
    if (!match || Number(match[1]) > Number(match[2]))
        throw new Error(
            `CAXRI_VITEST_SHARD must be <index>/<count>, received ${value ?? 'nothing'}`,
        );
    return value as string;
}

/**
 * Hosted Vitest runs beside the lint and type gates instead of after them, split across shards of one exact tree. The
 * `full` scope keeps the complete suite (`bun run test`); `affected` keeps `vitest related` over the changed sources.
 * Every shard of a scope must pass for the CI gate to accept it.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-unit-tests.test.ts
export function unitTestCommand(
    scope: Extract<CIChecksScope, 'affected' | 'full'>,
    shard: string,
    currentFiles: readonly string[],
    environment: NodeJS.ProcessEnv,
): { arguments: string[]; command: string } | undefined {
    if (scope === 'full') {
        const partition = environment.CAXRI_VITEST_PARTITION ?? 'optimized';
        const workers = environment.CAXRI_VITEST_MAX_WORKERS ?? '2';
        return {
            arguments: [
                'run',
                'scripts/ci-metrics.ts',
                '--label',
                `Vitest full suite partition=${partition} workers=${workers} shard=${shard}`,
                '--',
                'bun',
                'run',
                'test',
                `--shard=${shard}`,
            ],
            command: 'bun',
        };
    }
    const affected = affectedTestArguments(currentFiles);
    if (!affected) return undefined;
    return { arguments: [...affected, `--shard=${shard}`], command: 'bunx' };
}

function validatePath(path: string): string {
    const normalized = normalize(path);
    if (
        !path ||
        normalized === '..' ||
        isAbsolute(path) ||
        normalized.startsWith(`..${sep}`) ||
        path.includes('\0')
    ) {
        throw new Error(`Invalid changed path: ${JSON.stringify(path)}`);
    }
    return normalized;
}

async function main(): Promise<void> {
    const scope = process.env.CI_CHECKS_SCOPE;
    if (scope !== 'affected' && scope !== 'full')
        throw new Error(`Unsupported unit test scope: ${scope ?? 'missing'}`);
    const shard = parseShard(process.env.CAXRI_VITEST_SHARD);
    const value: unknown = JSON.parse(process.env.CI_CHANGED_FILES ?? '[]');
    if (!Array.isArray(value) || value.some((path) => typeof path !== 'string'))
        throw new Error('CI_CHANGED_FILES must be a JSON array of repository paths');
    const currentFiles = (
        await Promise.all(
            (value as string[]).map(validatePath).map(async (path) => {
                try {
                    await access(resolve(projectRoot, path));
                    return path;
                } catch {
                    return;
                }
            }),
        )
    ).filter((path): path is string => path !== undefined);
    const command = unitTestCommand(scope, shard, currentFiles, process.env);
    if (!command) {
        console.log('No changed source file selects a related Vitest suite.');
        return;
    }
    const startedAt = Date.now();
    process.exitCode = await runChildProcess(command.command, command.arguments, {
        cwd: projectRoot,
        stdio: 'inherit',
    });
    if (process.exitCode !== 0) await printNodeCrashReports(startedAt);
}

if (import.meta.main) await main();

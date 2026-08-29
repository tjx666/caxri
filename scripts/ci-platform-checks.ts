#!/usr/bin/env bun

import process from 'node:process';

import { runChildProcess } from './exec';

interface PlatformCheckCommand {
    arguments: string[];
    command: string;
    label: string;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-concurrent-validation.test.ts
export function platformCheckCommands(environment: NodeJS.ProcessEnv): PlatformCheckCommand[] {
    const eslintConcurrency = environment.ESLINT_CONCURRENCY ?? 'off';
    const vitestPartition = environment.CAXRI_VITEST_PARTITION ?? 'optimized';
    const vitestWorkers = environment.CAXRI_VITEST_MAX_WORKERS ?? '2';
    return [
        {
            arguments: ['run', 'scripts/prepare-node-pty.ts'],
            command: 'bun',
            label: 'node-pty spawn helper',
        },
        {
            arguments: [
                'run',
                'scripts/ci-metrics.ts',
                '--label',
                `ESLint concurrency=${eslintConcurrency}`,
                '--',
                'bun',
                'run',
                'lint',
                '--concurrency',
                eslintConcurrency,
            ],
            command: 'bun',
            label: 'ESLint',
        },
        {
            arguments: [
                'run',
                'scripts/ci-metrics.ts',
                '--label',
                'oxlint type-aware',
                '--',
                'bun',
                'run',
                'lint:type-aware',
            ],
            command: 'bun',
            label: 'oxlint type-aware',
        },
        { arguments: ['run', 'lint:markdown'], command: 'bun', label: 'markdownlint' },
        { arguments: ['run', 'knip'], command: 'bun', label: 'knip' },
        { arguments: ['run', 'doctor:changed'], command: 'bun', label: 'React Doctor' },
        { arguments: ['run', 'typecheck'], command: 'bun', label: 'TypeScript' },
        { arguments: ['run', 'format:check'], command: 'bun', label: 'format' },
        {
            arguments: [
                'run',
                'scripts/ci-metrics.ts',
                '--label',
                `Vitest full suite partition=${vitestPartition} workers=${vitestWorkers}`,
                '--',
                'bun',
                'run',
                'test',
            ],
            command: 'bun',
            label: 'unit and integration tests',
        },
        {
            arguments: [
                'run',
                'scripts/ci-metrics.ts',
                '--label',
                'Bundle budget gate',
                '--',
                'bun',
                'run',
                'scripts/ci-bundle-budget.ts',
            ],
            command: 'bun',
            label: 'bundle budget',
        },
    ];
}

async function main(): Promise<void> {
    for (const check of platformCheckCommands(process.env)) {
        // eslint-disable-next-line no-await-in-loop -- matches the fail-fast ordering of the former workflow steps
        const result = await runChildProcess(check.command, check.arguments, { stdio: 'inherit' });
        if (result === 0) continue;
        console.error(
            `Full platform checks stopped after ${check.label} failed with exit ${result}.`,
        );
        process.exitCode = result;
        return;
    }
}

if (import.meta.main) await main();

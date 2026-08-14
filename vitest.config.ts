import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const testFiles = [
    'src/**/*.test.ts',
    'packages/**/*.test.ts',
    '.agents/skills/**/scripts/*.test.ts',
    'scripts/__tests__/*.test.ts',
];
const serialNativeTestPrefix = [
    'src/runtime/__tests__/agent-hooks.integration.test.ts',
    'src/runtime/__tests__/configuration.test.ts',
    'src/runtime/agents/hooks/__tests__/manager.integration.test.ts',
];

export type VitestPartition = 'legacy' | 'optimized';

export interface VitestPartitionConfig {
    maxWorkers: 1 | 2 | 3 | 4;
    serialNativeTests: string[];
}

/** Keeps the control profile available for same-head CI performance comparisons. */
export function resolveVitestPartition(
    environment: NodeJS.ProcessEnv = process.env,
): VitestPartitionConfig {
    const partition = environment.CAXRI_VITEST_PARTITION ?? 'optimized';
    if (partition !== 'legacy' && partition !== 'optimized') {
        throw new Error(
            `CAXRI_VITEST_PARTITION must be legacy or optimized, received ${partition}`,
        );
    }

    const rawWorkers = environment.CAXRI_VITEST_MAX_WORKERS ?? '2';
    if (!['1', '2', '3', '4'].includes(rawWorkers)) {
        throw new Error(`CAXRI_VITEST_MAX_WORKERS must be 1, 2, 3, or 4, received ${rawWorkers}`);
    }

    return {
        maxWorkers: Number(rawWorkers) as 1 | 2 | 3 | 4,
        serialNativeTests: [
            ...serialNativeTestPrefix,
            partition === 'legacy'
                ? 'src/runtime/files/__tests__/*.test.ts'
                : 'src/runtime/files/__tests__/files.integration.test.ts',
            'src/runtime/git/__tests__/git.integration.test.ts',
        ],
    };
}

const partition = resolveVitestPartition();
export const serialNativeTests = partition.serialNativeTests;
export const parallelMaxWorkers = partition.maxWorkers;

export default defineConfig({
    resolve: {
        alias: {
            '@': resolve(import.meta.dirname, 'src/renderer/src'),
            '@caxri/cli': resolve(import.meta.dirname, 'packages/cli/src/index.ts'),
            '@caxri/protocol': resolve(import.meta.dirname, 'packages/protocol/src/index.ts'),
            '@shared': resolve(import.meta.dirname, 'src/shared'),
        },
    },
    test: {
        environment: 'node',
        testTimeout: 15_000,
        hookTimeout: 15_000,
        coverage: { reporter: ['text', 'json-summary'] },
        projects: [
            {
                extends: true,
                test: {
                    name: 'parallel',
                    include: testFiles,
                    exclude: serialNativeTests,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'serial-native',
                    /** Native watchers and process-global environment fixtures cannot overlap. */
                    fileParallelism: false,
                    include: serialNativeTests,
                },
            },
        ],
    },
});

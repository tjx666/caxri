import { resolve } from 'node:path';
import process from 'node:process';

import { defineConfig } from 'vitest/config';

export const desktopTestFiles = [
    'apps/desktop/src/**/*.test.ts',
    'apps/server/src/**/*.test.ts',
    'src/**/*.test.ts',
    'extensions/**/*.test.ts',
    'e2e/support/*.test.ts',
    '.agents/skills/**/scripts/*.test.ts',
    '.agents/skills/**/scripts/__tests__/*.test.ts',
    'scripts/__tests__/*.test.ts',
];
export const protocolTestFiles = ['packages/protocol/src/**/*.test.ts'];
export const agentSkillsTestFiles = ['packages/agent-skills/{scripts,src}/**/*.test.ts'];
export const apiTestFiles = ['packages/extension-api/src/**/*.test.ts'];
export const clientTestFiles = ['packages/client/src/**/*.test.ts'];
export const utilitiesTestFiles = ['packages/utils/src/**/*.test.ts'];
export const cliTestFiles = [
    'apps/cli/{scripts,src}/**/*.test.ts',
    'packages/cli/{scripts,src}/**/*.test.ts',
];
export const testProjectNames = [
    'desktop-parallel',
    'desktop-serial-native',
    'agent-skills',
    'protocol',
    'api',
    'client',
    'utils',
    'cli',
];
const serialNativeTestPrefix = [
    'apps/server/src/runtime/__tests__/agent-hooks.integration.test.ts',
    'apps/server/src/runtime/__tests__/configuration.test.ts',
    'apps/server/src/runtime/agents/hooks/__tests__/manager.integration.test.ts',
    'src/runtime/__tests__/agent-hooks.integration.test.ts',
    'src/runtime/__tests__/configuration.test.ts',
    'src/runtime/agents/hooks/__tests__/manager.integration.test.ts',
];

export type VitestPartition = 'legacy' | 'optimized';

export interface VitestPartitionConfig {
    maxWorkers: 1 | 2 | 3 | 4;
    serialNativeTests: string[];
}

/**
 * Keeps the control profile available for same-head CI performance comparisons.
 */
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
            partition === 'legacy'
                ? 'apps/server/src/runtime/files/__tests__/*.test.ts'
                : 'apps/server/src/runtime/files/__tests__/files.integration.test.ts',
            'src/runtime/git/__tests__/git.integration.test.ts',
            'apps/server/src/runtime/git/__tests__/git.integration.test.ts',
        ],
    };
}

const partition = resolveVitestPartition();
export const serialNativeTests = partition.serialNativeTests;
export const parallelMaxWorkers = partition.maxWorkers;

export const workspaceAliases = {
    '@': resolve(import.meta.dirname, 'src/renderer/src'),
    '@caxri/agent-skills/testing': resolve(
        import.meta.dirname,
        'packages/agent-skills/src/testing.ts',
    ),
    '@caxri/agent-skills': resolve(import.meta.dirname, 'packages/agent-skills/src/index.ts'),
    '@caxri/client/connection': resolve(
        import.meta.dirname,
        'packages/client/src/connection/index.ts',
    ),
    '@caxri/client/state': resolve(import.meta.dirname, 'packages/client/src/state/index.ts'),
    '@caxri/client/supervise': resolve(
        import.meta.dirname,
        'packages/client/src/supervise/index.ts',
    ),
    '@caxri/client': resolve(import.meta.dirname, 'packages/client/src/index.ts'),
    '@caxri/cli': resolve(import.meta.dirname, 'packages/cli/src/index.ts'),
    '@caxri/protocol': resolve(import.meta.dirname, 'packages/protocol/src/index.ts'),
    '@caxri/utils': resolve(import.meta.dirname, 'packages/utils/src/index.ts'),
    '@shared': resolve(import.meta.dirname, 'src/shared'),
    'caxri': resolve(import.meta.dirname, 'packages/extension-api/src/index.ts'),
};

export default defineConfig({
    resolve: {
        alias: workspaceAliases,
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
                    name: 'desktop-parallel',
                    include: desktopTestFiles,
                    exclude: serialNativeTests,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'desktop-serial-native',
                    /**
                     * Native watchers and process-global environment fixtures cannot overlap.
                     */
                    fileParallelism: false,
                    include: serialNativeTests,
                },
            },
            {
                extends: true,
                test: {
                    name: 'agent-skills',
                    include: agentSkillsTestFiles,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'protocol',
                    include: protocolTestFiles,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'api',
                    include: apiTestFiles,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'client',
                    include: clientTestFiles,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'utils',
                    include: utilitiesTestFiles,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'cli',
                    include: cliTestFiles,
                    maxWorkers: parallelMaxWorkers,
                },
            },
        ],
    },
});

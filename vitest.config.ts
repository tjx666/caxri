import { resolve } from 'node:path';
import process from 'node:process';

import { configDefaults, defineConfig } from 'vitest/config';

export const desktopTestFiles = [
    'apps/desktop/src/**/*.test.ts',
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
export const serverTestFiles = ['apps/server/{scripts,src}/**/*.test.ts'];
export const systemTestFiles = ['packages/system/src/**/*.test.ts'];
export const utilitiesTestFiles = ['packages/utils/src/**/*.test.ts'];
export const cliTestFiles = ['apps/cli/{scripts,src}/**/*.test.ts'];
export const mobileTestFiles = ['apps/mobile/{plugins,scripts,src}/**/*.test.ts'];
export const mobileTransportTestFiles = ['packages/mobile-transport/src/**/*.test.ts'];
export const markdownTestFiles = ['packages/markdown/src/**/*.test.ts'];
export const testProjectNames = [
    'desktop-parallel',
    'agent-skills',
    'protocol',
    'api',
    'client',
    'server-parallel',
    'server-serial-native',
    'system',
    'utils',
    'cli',
    'mobile',
    'mobile-transport',
    'markdown',
];
const serialNativeTestPrefix = [
    'apps/server/src/domains/__tests__/agent-hooks.integration.test.ts',
    'apps/server/src/domains/__tests__/configuration-fanout.test.ts',
    'apps/server/src/domains/__tests__/configuration.test.ts',
    'apps/server/src/domains/agents/hooks/__tests__/manager-observability.integration.test.ts',
    'apps/server/src/domains/agents/hooks/__tests__/manager.integration.test.ts',
    /**
     * The real-process suite loads node-pty. Its worker must finish native child teardown before another native suite
     * starts on macOS CI.
     */
    'apps/server/src/domains/terminal/__tests__/terminal-process.integration.test.ts',
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
                ? 'apps/server/src/domains/files/__tests__/*.test.ts'
                : 'apps/server/src/domains/files/__tests__/files.integration.test.ts',
            'apps/server/src/domains/git/__tests__/git.integration.test.ts',
        ],
    };
}

const partition = resolveVitestPartition();
export const serialNativeTests = partition.serialNativeTests;
export const serverParallelExcludes = [...configDefaults.exclude, ...serialNativeTests];
export const parallelMaxWorkers = partition.maxWorkers;

export const workspaceAliases = {
    '@': resolve(import.meta.dirname, 'apps/desktop/src/renderer/src'),
    '@desktop-shared': resolve(import.meta.dirname, 'apps/desktop/src/shared'),
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
    '@caxri/markdown': resolve(import.meta.dirname, 'packages/markdown/src/index.ts'),
    '@caxri/mobile-transport': resolve(
        import.meta.dirname,
        'packages/mobile-transport/src/index.ts',
    ),
    '@caxri/protocol': resolve(import.meta.dirname, 'packages/protocol/src/index.ts'),
    '@caxri/system': resolve(import.meta.dirname, 'packages/system/src/index.ts'),
    '@caxri/utils': resolve(import.meta.dirname, 'packages/utils/src/index.ts'),
    'caxri': resolve(import.meta.dirname, 'packages/extension-api/src/index.ts'),
};

export default defineConfig({
    resolve: {
        alias: workspaceAliases,
    },
    /**
     * Mirrors the Renderer build's `assetsInclude` (electron.vite.config.ts) so the PDF preview's `?inline` CMaps,
     * standard fonts, and WebAssembly decoders load in tests exactly as they are bundled.
     */
    assetsInclude: ['**/*.bcmap', '**/*.pfb', '**/*.wasm'],
    test: {
        globalSetup: ['./vitest.global-setup.ts'],
        environment: 'node',
        testTimeout: 15_000,
        hookTimeout: 15_000,
        coverage: { reporter: ['text', 'json-summary'] },
        /**
         * Vitest replaces every CSS import with an empty string unless `css.include` matches it, and that includes
         * `theme.css?raw`. Contract tests import the stylesheets they assert on with `?raw` so the changed-file check
         * and watch mode see the dependency; matching only the raw query keeps ordinary style imports empty.
         */
        css: { include: [/[?&]raw(?:&|$)/] },
        projects: [
            {
                extends: true,
                test: {
                    name: 'desktop-parallel',
                    include: desktopTestFiles,
                    exclude: configDefaults.exclude,
                    maxWorkers: parallelMaxWorkers,
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
                    name: 'server-parallel',
                    include: serverTestFiles,
                    exclude: serverParallelExcludes,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'server-serial-native',
                    fileParallelism: false,
                    include: serialNativeTests,
                },
            },
            {
                extends: true,
                test: {
                    name: 'system',
                    include: systemTestFiles,
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
            {
                extends: true,
                test: {
                    name: 'mobile',
                    include: mobileTestFiles,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'mobile-transport',
                    include: mobileTransportTestFiles,
                    maxWorkers: parallelMaxWorkers,
                },
            },
            {
                extends: true,
                test: {
                    name: 'markdown',
                    include: markdownTestFiles,
                    maxWorkers: parallelMaxWorkers,
                },
            },
        ],
    },
});

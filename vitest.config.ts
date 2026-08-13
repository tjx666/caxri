import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const testFiles = ['src/**/*.test.ts', '.agents/skills/**/scripts/*.test.ts', 'scripts/*.test.ts'];
const serialNativeTests = [
    'src/runtime/__tests__/agent-hooks.integration.test.ts',
    'src/runtime/__tests__/configuration.test.ts',
    'src/runtime/agents/hooks/__tests__/manager.integration.test.ts',
    'src/runtime/files/__tests__/*.test.ts',
    'src/runtime/git/__tests__/git.integration.test.ts',
];

export default defineConfig({
    resolve: {
        alias: {
            '@': resolve('src/renderer/src'),
            '@shared': resolve('src/shared'),
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
                    maxWorkers: 2,
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

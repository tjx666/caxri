import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '@': resolve('src/renderer/src'),
            '@shared': resolve('src/shared'),
        },
    },
    test: {
        environment: 'node',
        /** Native watcher streams are process-global and must not be exercised by parallel test workers. */
        fileParallelism: false,
        include: ['src/**/*.test.ts'],
        testTimeout: 15_000,
        hookTimeout: 15_000,
        coverage: { reporter: ['text', 'json-summary'] },
    },
});

import process from 'node:process';

import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    testMatch: '**/*.e2e.ts',
    outputDir: process.env.CAXRI_E2E_OUTPUT_DIR ?? 'test-results',
    timeout: 90_000,
    expect: { timeout: 15_000 },
    maxFailures: process.env.CI ? 3 : 0,
    workers: 1,
    reporter: [['list']],
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
});

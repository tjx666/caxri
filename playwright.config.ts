import process from 'node:process';

import { defineConfig } from '@playwright/test';

import {
    publicE2EReporterPath,
    shouldUsePublicE2EReporter,
} from './scripts/reporters/public-e2e-reporter-policy';

export default defineConfig({
    globalSetup: './e2e/support/full-suite-guard.ts',
    testDir: './e2e',
    testMatch: '**/*.e2e.ts',
    outputDir: process.env.CAXRI_E2E_OUTPUT_DIR ?? 'test-results',
    timeout: 90_000,
    expect: { timeout: 15_000 },
    maxFailures: process.env.CI ? 3 : 0,
    workers: 1,
    reporter: [[shouldUsePublicE2EReporter(process.env) ? publicE2EReporterPath : 'list']],
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
});

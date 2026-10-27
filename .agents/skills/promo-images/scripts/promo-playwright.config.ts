import process from 'node:process';

import { defineConfig } from '@playwright/test';

/**
 * Runs only the promo capture spec; `promo.ts` starts it. It is not an E2E suite: no retries, no traces, videos or
 * failure screenshots (they would capture the seeded demo outside the reviewed output), and Playwright's own output
 * goes under the run's gitignored `.records/` directory.
 */
export default defineConfig({
    testDir: '.',
    testMatch: 'promo-capture.pw.ts',
    outputDir: process.env.CAXRI_PROMO_CAPTURE_DIR
        ? `${process.env.CAXRI_PROMO_CAPTURE_DIR}/playwright`
        : '../../../../.records/promo-images/playwright',
    timeout: 10 * 60_000,
    expect: { timeout: 30_000 },
    workers: 1,
    retries: 0,
    reporter: [['list']],
    use: { trace: 'off', screenshot: 'off', video: 'off' },
});

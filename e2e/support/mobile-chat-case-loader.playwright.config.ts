import { defineConfig } from '@playwright/test';

/**
 * Runs only `mobile-chat-case-loader.probe.ts` (`mobile-chat-case-loader.test.ts` starts it). The probe needs
 * Playwright's own loader, so it cannot run under Vitest, and it stays out of the Electron suite's `*.e2e.ts` match.
 */
export default defineConfig({
    reporter: 'line',
    testDir: import.meta.dirname,
    testMatch: 'mobile-chat-case-loader.probe.ts',
    workers: 1,
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
    outputDir: '../../test-results/census-fixture/artifacts',
    testDir: '.',
    testMatch: 'e2e-census.fixture.ts',
    workers: 1,
});

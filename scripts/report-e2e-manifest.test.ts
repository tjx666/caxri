import { describe, expect, it } from 'vitest';

import { summarizeE2EManifest } from './report-e2e-manifest';

describe('E2E manifest summary', () => {
    it('publishes a stable hash and exact Playwright test count', () => {
        const output = `Listing tests:\n  [electron] › e2e/example.e2e.ts:1:1 › first\n  [electron] › e2e/example.e2e.ts:2:1 › second\nTotal: 2 tests in 1 file`;
        const first = summarizeE2EManifest(output);

        expect(first.tests).toBe(2);
        expect(first.hash).toMatch(/^[0-9a-f]{64}$/u);
        expect(summarizeE2EManifest(output)).toEqual(first);
        expect(summarizeE2EManifest(output.replace('second', 'changed')).hash).not.toBe(first.hash);
    });

    it('fails closed when Playwright omits the total', () => {
        expect(() => summarizeE2EManifest('Listing tests:')).toThrow(
            'Playwright list output did not include a test total',
        );
    });
});

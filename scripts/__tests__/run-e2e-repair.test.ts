import { describe, expect, it } from 'vitest';

import { parseE2EPool, parseSpecPaths } from '../run-e2e-repair';

describe('focused E2E repair argv', () => {
    it('accepts only unique repository E2E spec paths', () => {
        expect(
            parseSpecPaths('["e2e/files.e2e.ts","e2e/terminal-links.e2e.ts","e2e/files.e2e.ts"]'),
        ).toEqual(['e2e/files.e2e.ts', 'e2e/terminal-links.e2e.ts']);
    });

    it.each([
        'null',
        '[]',
        '["--grep","secret"]',
        '["../outside.e2e.ts"]',
        '["/tmp/outside.e2e.ts"]',
        '["e2e/not-a-spec.ts"]',
    ])('rejects non-spec argv %s', (value) => {
        expect(() => parseSpecPaths(value)).toThrow('validated E2E spec paths');
    });

    it('keeps focused retries aligned with the failed hosted pool', () => {
        expect(parseE2EPool(undefined)).toBe('control');
        expect(parseE2EPool('parallel-safe')).toBe('parallel-safe');
        expect(parseE2EPool('desktop-exclusive')).toBe('desktop-exclusive');
        expect(() => parseE2EPool('unknown')).toThrow('CI_E2E_POOL');
    });
});

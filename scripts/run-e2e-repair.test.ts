import { describe, expect, it } from 'vitest';

import { parseSpecPaths } from './run-e2e-repair';

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
});

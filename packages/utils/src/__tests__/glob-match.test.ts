import { describe, expect, it } from 'vitest';

import { isGlobMatch } from '../glob-match';

describe('isGlobMatch', () => {
    it.each([
        ['root test file', 'feature.test.ts'],
        ['nested spec file', 'src/feature.spec.tsx'],
        ['root __tests__ file', '__tests__/feature.ts'],
        ['nested __tests__ file', 'src/__tests__/feature.ts'],
    ])('matches %s', (_scenario, path) => {
        expect(
            isGlobMatch(path, {
                '**/*.test.*': true,
                '**/*.spec.*': true,
                '**/__tests__/**': true,
            }),
        ).toBe(true);
    });

    it('normalizes separators and honors disabled and empty patterns', () => {
        expect(
            isGlobMatch(String.raw`src\__tests__\feature.ts`, {
                '': true,
                '**/__tests__/**': true,
                '**/*.test.*': false,
            }),
        ).toBe(true);
        expect(isGlobMatch('src/feature.test.ts', { '**/*.test.*': false })).toBe(false);
    });
});

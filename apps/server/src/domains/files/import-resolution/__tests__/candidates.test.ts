import { describe, expect, it } from 'vitest';

import { isRelativeImportSpecifier, relativeImportCandidatePaths } from '../candidates';

describe('isRelativeImportSpecifier', () => {
    it('accepts only paths written relative to the importing document', () => {
        expect(isRelativeImportSpecifier('./foo')).toBe(true);
        expect(isRelativeImportSpecifier('../../errors')).toBe(true);
        expect(isRelativeImportSpecifier('openai')).toBe(false);
        expect(isRelativeImportSpecifier('@/lib/utilities')).toBe(false);
        expect(isRelativeImportSpecifier('/absolute/path')).toBe(false);
    });
});

describe('relativeImportCandidatePaths', () => {
    const from = '/project/src/features/index.ts';

    it('tries the written path first, then each source extension, then the directory barrel', () => {
        const candidates = relativeImportCandidatePaths(from, './foo');

        expect(candidates[0]).toBe('/project/src/features/foo');
        expect(candidates).toContain('/project/src/features/foo.ts');
        expect(candidates).toContain('/project/src/features/foo.tsx');
        expect(candidates).toContain('/project/src/features/foo/index.ts');
        expect(candidates.indexOf('/project/src/features/foo.ts')).toBeLessThan(
            candidates.indexOf('/project/src/features/foo/index.ts'),
        );
    });

    it('walks up for a parent specifier', () => {
        expect(relativeImportCandidatePaths(from, '../../errors')).toContain(
            '/project/errors/index.ts',
        );
        expect(relativeImportCandidatePaths(from, '../../errors')).toContain('/project/errors.ts');
    });

    it('treats an ESM .js specifier as its TypeScript source', () => {
        const candidates = relativeImportCandidatePaths(from, './domain.js');

        // A real `domain.js` still wins when it exists; `domain.ts` is the very next guess, which is what makes
        // `from './domain.js'` in TypeScript ESM source open the file the author actually wrote.
        expect(candidates.slice(0, 3)).toEqual([
            '/project/src/features/domain.js',
            '/project/src/features/domain.ts',
            '/project/src/features/domain.tsx',
        ]);
    });

    it('produces nothing for a specifier this feature does not resolve', () => {
        expect(relativeImportCandidatePaths(from, 'openai')).toEqual([]);
        expect(relativeImportCandidatePaths(from, '@/lib/utilities')).toEqual([]);
        expect(relativeImportCandidatePaths(from, '/etc/passwd')).toEqual([]);
    });

    it('never repeats a candidate', () => {
        const candidates = relativeImportCandidatePaths(from, './foo.ts');

        expect(new Set(candidates).size).toBe(candidates.length);
    });
});

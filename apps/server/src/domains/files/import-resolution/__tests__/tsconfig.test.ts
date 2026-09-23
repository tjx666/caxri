import { describe, expect, it } from 'vitest';

import { tsconfigImportTargets } from '../tsconfig';

describe('tsconfigImportTargets', () => {
    it('prefers exact aliases, then the longest wildcard prefix without retrying a broader alias', () => {
        const config = {
            pathsDirectory: '/project',
            paths: {
                '*': ['fallback/*'],
                '@/*': ['source/*'],
                '@/feature/*': ['first/*', 'second/*'],
                '@/feature/exact': ['exact.ts'],
            },
        };
        expect(tsconfigImportTargets(config, '@/feature/exact')).toEqual(['/project/exact.ts']);
        expect(tsconfigImportTargets(config, '@/feature/value')).toEqual([
            '/project/first/value',
            '/project/second/value',
        ]);
    });

    it('uses inherited baseUrl and substitutes dollar characters literally', () => {
        const config = {
            baseUrl: '/project/source',
            pathsDirectory: '/project/config',
            paths: { '@/*': ['./*'] },
        };
        expect(tsconfigImportTargets(config, '@/$&')).toEqual(['/project/source/$&']);
        expect(tsconfigImportTargets(config, 'other')).toEqual(['/project/source/other']);
    });

    it('never treats absolute, relative or scheme paths as baseUrl imports', () => {
        const config = { baseUrl: '/project' };
        for (const value of [
            '/outside',
            '../outside',
            './relative',
            'node:fs',
            'https://example.com',
            'bad\0name',
        ]) {
            expect(tsconfigImportTargets(config, value)).toEqual([]);
        }
    });
});

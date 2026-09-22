import { describe, expect, it } from 'vitest';

import { packageEntryTargets, packageFileCandidates } from '../packages';

describe('package entry targets', () => {
    it('prefers type conditions, including nested runtime exports', () => {
        expect(
            packageEntryTargets(
                {
                    exports: {
                        import: { types: './types.d.ts', default: './index.js' },
                        default: './fallback.js',
                    },
                },
                '',
            ),
        ).toEqual(['./types.d.ts', './index.js']);
    });

    it('honors exact null entries and the longest wildcard without leaking private files', () => {
        const metadata = {
            main: './main.js',
            exports: {
                './*': './dist/*.js',
                './feature/*': './special/*.js',
                './feature/private': null,
            },
        };
        expect(packageEntryTargets(metadata, 'feature/value')).toEqual(['./special/value.js']);
        expect(packageEntryTargets(metadata, 'feature/private')).toEqual([]);
        expect(packageEntryTargets(metadata, '')).toEqual([]);
        expect(packageEntryTargets({ exports: './index.js' }, 'private')).toEqual([]);
    });

    it('rejects traversal and invalid export targets', () => {
        for (const target of [
            '../outside.js',
            './nested/../../outside.js',
            './node_modules/other/index.js',
            './%2e%2e/outside.js',
            '/absolute.js',
        ]) {
            expect(packageEntryTargets({ exports: target }, '')).toEqual([]);
        }
    });

    it('orders legacy declaration fields before runtime fields', () => {
        expect(
            packageEntryTargets(
                {
                    types: './types.d.ts',
                    typings: './old.d.ts',
                    main: './main.js',
                    module: './module.js',
                },
                '',
            ),
        ).toEqual(['./types.d.ts', './old.d.ts', './main.js', './module.js', './index']);
    });
});

describe('package file candidates', () => {
    it('prefers declarations while keeping exact declaration and extensionless files reachable', () => {
        expect(packageFileCandidates('/package/index.mts')[0]).toBe('/package/index.d.mts');
        expect(packageFileCandidates('/package/index.cts')[0]).toBe('/package/index.d.cts');
        expect(packageFileCandidates('/package/index.d.ts')).toEqual(['/package/index.d.ts']);
        expect(packageFileCandidates('/package/index.mjs').slice(0, 2)).toEqual([
            '/package/index.d.mts',
            '/package/index.mjs',
        ]);
        expect(packageFileCandidates('/package/index.cjs').slice(0, 2)).toEqual([
            '/package/index.d.cts',
            '/package/index.cjs',
        ]);
        expect(packageFileCandidates('/package/entry').slice(0, 2)).toEqual([
            '/package/entry.d.ts',
            '/package/entry',
        ]);
    });
});

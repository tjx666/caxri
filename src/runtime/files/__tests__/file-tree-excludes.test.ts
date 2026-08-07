import { describe, expect, it } from 'vitest';

import { matchesFileTreeExclude } from '../file-tree-excludes';

describe('matchesFileTreeExclude', () => {
    it.each(['.git', 'nested/.git', 'packages/app/.DS_Store'])(
        'matches VS Code-style recursive patterns for %s',
        (path) => {
            expect(
                matchesFileTreeExclude(path, {
                    '**/.git': true,
                    '**/.DS_Store': true,
                }),
            ).toBe(true);
        },
    );

    it('supports basename, single-segment, and subtree globs', () => {
        const excludes = {
            '*.generated': true,
            'packages/*/cache': true,
            '**/fixtures/**': true,
        };

        expect(matchesFileTreeExclude('src/client.generated', excludes)).toBe(true);
        expect(matchesFileTreeExclude('packages/app/cache', excludes)).toBe(true);
        expect(matchesFileTreeExclude('src/fixtures/nested/data.json', excludes)).toBe(true);
        expect(matchesFileTreeExclude('packages/app/source.ts', excludes)).toBe(false);
    });

    it('keeps disabled patterns visible', () => {
        expect(matchesFileTreeExclude('.git', { '**/.git': false })).toBe(false);
    });
});

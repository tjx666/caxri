import { describe, expect, it } from 'vitest';

import { isFileTreeExcludeMatch } from '../file-tree-excludes';

describe('isFileTreeExcludeMatch', () => {
    it.each(['.git', 'nested/.git', 'packages/app/.DS_Store'])(
        'matches VS Code-style recursive patterns for %s',
        (path) => {
            expect(
                isFileTreeExcludeMatch(path, {
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

        expect(isFileTreeExcludeMatch('src/client.generated', excludes)).toBe(true);
        expect(isFileTreeExcludeMatch('packages/app/cache', excludes)).toBe(true);
        expect(isFileTreeExcludeMatch('src/fixtures/nested/data.json', excludes)).toBe(true);
        expect(isFileTreeExcludeMatch('packages/app/source.ts', excludes)).toBe(false);
    });

    it('keeps disabled patterns visible', () => {
        expect(isFileTreeExcludeMatch('.git', { '**/.git': false })).toBe(false);
    });
});

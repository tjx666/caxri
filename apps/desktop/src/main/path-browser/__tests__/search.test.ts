import { describe, expect, it } from 'vitest';

import type { ProjectSearchMatch } from '../search';
import { memoizedProjectSearch, rankProjectSearchMatches, rememberProjectSearch } from '../search';

function match(relativePath: string) {
    return { path: `/root/${relativePath}`, relativePath };
}

describe('rankProjectSearchMatches', () => {
    it('splits each hit into the file name and its Project-relative directory', () => {
        const [nested, top] = rankProjectSearchMatches(
            [match('packages/model/src/resolve.ts'), match('resolve.ts')],
            'resolve',
            10,
        ).toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));

        expect(nested).toMatchObject({
            directoryLabel: 'packages/model/src',
            name: 'resolve.ts',
        });
        // A root-level hit has no directory to disambiguate it, so the label stays empty rather than showing `.`.
        expect(top).toMatchObject({ directoryLabel: '', name: 'resolve.ts' });
    });

    it('caps the result at the snapshot entry budget', () => {
        const ranked = rankProjectSearchMatches(
            Array.from({ length: 10 }, (_, index) => match(`dir-${index}/thing.ts`)),
            'thing',
            3,
        );

        expect(ranked).toHaveLength(3);
    });
});

describe('project search memo', () => {
    function memo(entries: Array<[string, ProjectSearchMatch[]]> = []) {
        return new Map(entries);
    }

    it('answers a longer name from an earlier scan, case-insensitively', () => {
        const store = memo();
        rememberProjectSearch(store, 'Resolve', [
            match('a/resolveSafeMaxTokens.ts'),
            match('a/resolveTheme.ts'),
        ]);

        expect(memoizedProjectSearch(store, 'resolveSAFE')).toEqual([
            match('a/resolveSafeMaxTokens.ts'),
        ]);
    });

    it('lets a scan that found nothing answer every longer name built from it', () => {
        const store = memo();
        rememberProjectSearch(store, 'zzz', []);

        expect(memoizedProjectSearch(store, 'zzz-more')).toEqual([]);
    });

    it('leaves an unrelated or shorter name to a fresh scan', () => {
        const store = memo();
        rememberProjectSearch(store, 'resolve', [match('a/resolve.ts')]);

        expect(memoizedProjectSearch(store, 'resolv')).toBeUndefined();
        expect(memoizedProjectSearch(store, 'theme')).toBeUndefined();
    });

    it('drops the oldest scan once the memo is full so a long dialog stays bounded', () => {
        const store = memo();
        for (let index = 0; index < 9; index += 1)
            rememberProjectSearch(store, `name-${index}`, [match(`a/name-${index}.ts`)]);

        expect(store.size).toBe(8);
        expect(memoizedProjectSearch(store, 'name-0')).toBeUndefined();
        expect(memoizedProjectSearch(store, 'name-8')).toEqual([match('a/name-8.ts')]);
    });
});

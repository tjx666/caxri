import { describe, expect, it } from 'vitest';

import { memoizedSubpathPrefix, projectSubpathSuffix } from '../subpath';

describe('projectSubpathSuffix', () => {
    it('keeps only the directory segments of a relative Project input', () => {
        expect(projectSubpathSuffix('packages/bank/index.ts')).toEqual(['packages', 'bank']);
        expect(projectSubpathSuffix('packages/bank/')).toEqual(['packages', 'bank']);
        expect(projectSubpathSuffix('bank/index.ts')).toEqual(['bank']);
    });

    it('refuses input the fallback must not resolve', () => {
        for (const input of ['index.ts', '/tmp/x/y', '~/x/y', '../x/y', './x/y', 'a//b/c'])
            expect(projectSubpathSuffix(input)).toBeUndefined();
    });
});

describe('memoizedSubpathPrefix', () => {
    it('extends positive and negative memo entries to deeper suffixes', () => {
        const memo = new Map<string, string | null>([
            ['packages', '/root/example'],
            ['packages/bank', '/root/example'],
            ['nowhere', null],
        ]);
        expect(memoizedSubpathPrefix(memo, 'packages/bank/src')).toBe('/root/example');
        expect(memoizedSubpathPrefix(memo, 'nowhere/deeper')).toBeNull();
        expect(memoizedSubpathPrefix(memo, 'packagesx')).toBeUndefined();
        expect(memoizedSubpathPrefix(memo, 'other')).toBeUndefined();
    });
});

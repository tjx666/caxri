import type { FileSearchMatch } from '@shared/types';
import { describe, expect, it } from 'vitest';

import { buildNameSearchTree, groupSearchMatches } from '../project-search-tree';

function match(relativePath: string, line?: number): FileSearchMatch {
    return {
        path: `/repo/${relativePath}`,
        relativePath,
        ...(line !== undefined && { line }),
    };
}

describe('project search tree', () => {
    it('builds nested directories and sorts directories before files at every level', () => {
        const tree = buildNameSearchTree([
            match('zeta.ts'),
            match('src/zeta.ts'),
            match('docs/readme.md'),
            match('alpha.ts'),
            match('src/alpha.ts'),
            match('src/nested/value.ts'),
        ]);

        expect(tree.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
            'directory:docs',
            'directory:src',
            'file:alpha.ts',
            'file:zeta.ts',
        ]);
        const source = tree[1];
        expect(source).toMatchObject({ kind: 'directory', relativePath: 'src' });
        if (source.kind !== 'directory') throw new Error('Expected src directory');
        expect(source.children.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
            'directory:nested',
            'file:alpha.ts',
            'file:zeta.ts',
        ]);
    });

    it('groups content matches by relative path without reordering matches', () => {
        const first = match('src/index.ts', 3);
        const second = match('src/index.ts', 8);
        const readme = match('README.md', 1);

        expect([...groupSearchMatches([first, readme, second])]).toEqual([
            ['src/index.ts', [first, second]],
            ['README.md', [readme]],
        ]);
    });
});

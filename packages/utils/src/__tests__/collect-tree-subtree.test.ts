import { describe, expect, it } from 'vitest';

import { collectTreeSubtree } from '../collect-tree-subtree';

describe('collectTreeSubtree', () => {
    it('visits each known descendant once while preserving child order', () => {
        const children = new Map<string, readonly string[]>([
            ['root', ['first', 'second']],
            ['first', ['leaf']],
            ['second', ['root']],
        ]);

        expect(collectTreeSubtree('root', (node) => children.get(node) ?? [])).toEqual([
            'root',
            'first',
            'leaf',
            'second',
        ]);
    });
});

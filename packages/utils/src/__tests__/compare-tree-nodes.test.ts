import { describe, expect, it } from 'vitest';

import { compareTreeNodesDirectoriesFirst } from '../compare-tree-nodes';

interface TreeNodeFixture {
    kind: 'directory' | 'file';
    name: string;
}

describe('compareTreeNodesDirectoriesFirst', () => {
    it('orders directories before files regardless of name', () => {
        const directory: TreeNodeFixture = { kind: 'directory', name: 'zebra' };
        const file: TreeNodeFixture = { kind: 'file', name: 'apple' };
        expect(compareTreeNodesDirectoriesFirst(directory, file)).toBeLessThan(0);
        expect(compareTreeNodesDirectoriesFirst(file, directory)).toBeGreaterThan(0);
    });

    it('breaks ties alphabetically within the same kind', () => {
        const a: TreeNodeFixture = { kind: 'file', name: 'apple.ts' };
        const b: TreeNodeFixture = { kind: 'file', name: 'banana.ts' };
        expect(compareTreeNodesDirectoriesFirst(a, b)).toBeLessThan(0);
        expect(compareTreeNodesDirectoriesFirst(b, a)).toBeGreaterThan(0);
        expect(compareTreeNodesDirectoriesFirst(a, a)).toBe(0);
    });
});

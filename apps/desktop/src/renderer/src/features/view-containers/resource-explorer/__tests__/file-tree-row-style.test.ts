import type { FileEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    FILE_TREE_ROW_HEIGHT,
    fileTreeLeafIndent,
    fileTreeRevealOffset,
    fileTreeRowStyle,
    MAX_STICKY_ANCESTORS,
    stickyFileTreeRows,
} from '../file-tree-row-style';
import type { FileTreeRow } from '../file-tree-rows';
import { flattenFileTree } from '../file-tree-rows';

const H = FILE_TREE_ROW_HEIGHT;

function directory(path: string): FileEntry {
    return { kind: 'directory', name: path.split('/').at(-1) ?? path, path };
}

function file(path: string): FileEntry {
    return { kind: 'file', name: path.split('/').at(-1) ?? path, path };
}

/**
 * `/p/a` holds `/p/a/b` (with `leafCount` files) and one sibling file; `/p/z` follows `/p/a` at the root.
 */
function nestedTree(leafCount: number): FileTreeRow[] {
    const listings = new Map<string, FileEntry[]>([
        ['/p', [directory('/p/a'), directory('/p/z')]],
        ['/p/a', [directory('/p/a/b'), file('/p/a/after.ts')]],
        [
            '/p/a/b',
            Array.from({ length: leafCount }, (_, index) => file(`/p/a/b/leaf-${index}.ts`)),
        ],
    ]);
    const expanded = new Set(['/p/a', '/p/a/b']);
    return flattenFileTree({
        isExpanded: (path) => expanded.has(path),
        listing: (path) => {
            const entries = listings.get(path);
            return entries ? { entries } : undefined;
        },
        root: '/p',
    }).rows;
}

function sticky(rows: readonly FileTreeRow[], scrollOffset: number) {
    return stickyFileTreeRows(
        rows,
        scrollOffset,
        (index) => (index < rows.length ? { start: index * H, end: (index + 1) * H } : undefined),
        (offset) => {
            const index = Math.floor(offset / H);
            return index >= 0 && index < rows.length ? index : undefined;
        },
    );
}

describe('fileTreeRowStyle', () => {
    it('indents a directory to its chevron and a leaf to the icon column', () => {
        expect(fileTreeRowStyle({ depth: 0, isDirectory: true })).toEqual({ paddingLeft: 8 });
        expect(fileTreeRowStyle({ depth: 2, isDirectory: true })).toEqual({ paddingLeft: 32 });
        expect(fileTreeRowStyle({ depth: 2, isDirectory: false })).toEqual({
            paddingLeft: fileTreeLeafIndent(2),
        });
        // A root file's icon sits where a root folder's icon does: 8px padding, 13px chevron, 8px gap.
        expect(fileTreeRowStyle({ depth: 0, isDirectory: false })).toEqual({ paddingLeft: 29 });
    });
});

describe('stickyFileTreeRows', () => {
    it('pins nothing while the tree sits at the top', () => {
        expect(sticky(nestedTree(40), 0)).toEqual([]);
    });

    it('stacks each ancestor one row below the previous once their rows scroll away', () => {
        const rows = nestedTree(40);
        // Row 0 is /p/a, row 1 is /p/a/b, rows 2.. are its leaves.
        expect(sticky(rows, 10 * H)).toEqual([
            { index: 0, top: 0 },
            { index: 1, top: H },
        ]);
    });

    it('pushes a pinned directory up as its subtree scrolls out and pins nothing deeper', () => {
        const rows = nestedTree(4);
        // /p/a/b's last leaf is row 5 (ending at 6H); /p/a/after.ts is row 6 and /p/z row 7.
        // Only 10px of that last leaf remain below the slot, so /p/a/b rides up to 10px from the top.
        expect(sticky(rows, 5 * H - 10)).toEqual([
            { index: 0, top: 0 },
            { index: 1, top: 10 },
        ]);
    });

    it('releases a directory once its whole subtree has scrolled past', () => {
        const rows = nestedTree(4);
        // Scrolled so /p/z (row 7) is at the top: /p/a's subtree ended at row 6.
        expect(sticky(rows, 7 * H)).toEqual([]);
    });

    it('caps the stack at the sticky ancestor limit', () => {
        const depth = MAX_STICKY_ANCESTORS + 3;
        const paths = Array.from({ length: depth }, (_, level) =>
            ['/p', ...Array.from({ length: level + 1 }, (_, part) => `d${part}`)].join('/'),
        );
        const listings = new Map<string, FileEntry[]>([['/p', [directory(paths[0])]]]);
        for (const [level, path] of paths.entries())
            listings.set(
                path,
                level + 1 < depth
                    ? [directory(paths[level + 1])]
                    : Array.from({ length: 50 }, (_, index) => file(`${path}/f-${index}.ts`)),
            );
        const rows = flattenFileTree({
            isExpanded: () => true,
            listing: (path) => {
                const entries = listings.get(path);
                return entries ? { entries } : undefined;
            },
            root: '/p',
        }).rows;

        expect(sticky(rows, 30 * H)).toHaveLength(MAX_STICKY_ANCESTORS);
    });
});

describe('fileTreeRevealOffset', () => {
    it('leaves a fully visible row alone', () => {
        expect(
            fileTreeRevealOffset({
                depth: 0,
                extent: { start: 5 * H, end: 6 * H },
                scrollOffset: 0,
                viewportHeight: 20 * H,
            }),
        ).toBeUndefined();
    });

    it('scrolls a row above the viewport to sit below its would-be sticky ancestors', () => {
        expect(
            fileTreeRevealOffset({
                depth: 2,
                extent: { start: 40 * H, end: 41 * H },
                scrollOffset: 60 * H,
                viewportHeight: 20 * H,
            }),
        ).toBe(38 * H);
    });

    it('scrolls a row below the viewport up to the bottom edge', () => {
        expect(
            fileTreeRevealOffset({
                depth: 1,
                extent: { start: 30 * H, end: 31 * H },
                scrollOffset: 0,
                viewportHeight: 20 * H,
            }),
        ).toBe(11 * H);
    });
});

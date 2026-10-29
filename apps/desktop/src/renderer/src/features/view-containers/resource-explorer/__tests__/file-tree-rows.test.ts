import type { FileEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { FlattenFileTreeInput } from '../file-tree-rows';
import { fileTreeNavigationTarget, flattenFileTree } from '../file-tree-rows';

function directory(path: string): FileEntry {
    return { kind: 'directory', name: path.split('/').at(-1) ?? path, path };
}

function file(path: string): FileEntry {
    return { kind: 'file', name: path.split('/').at(-1) ?? path, path };
}

function flatten(
    listings: Record<string, FileEntry[] | { entries: FileEntry[]; truncated: boolean }>,
    expanded: readonly string[],
    options: Partial<FlattenFileTreeInput> = {},
) {
    const expandedPaths = new Set(expanded);
    return flattenFileTree({
        isExpanded: (path) => expandedPaths.has(path),
        listing: (path) => {
            const listing = listings[path] as
                FileEntry[] | { entries: FileEntry[]; truncated: boolean } | undefined;
            if (listing === undefined) return;
            return Array.isArray(listing) ? { entries: listing } : listing;
        },
        root: '/p',
        ...options,
    });
}

function describeRows(rows: ReturnType<typeof flatten>['rows']): string[] {
    return rows.map((row) =>
        row.kind === 'entry' ? `${row.depth}:${row.entry.path}` : `${row.depth}:${row.kind}`,
    );
}

describe('flattenFileTree', () => {
    it('lists expanded children right after their directory in depth-first order', () => {
        const { directories, rows } = flatten(
            {
                '/p': [directory('/p/src'), file('/p/readme.md')],
                '/p/src': [file('/p/src/index.ts')],
            },
            ['/p/src'],
        );

        expect(describeRows(rows)).toEqual(['0:/p/src', '1:/p/src/index.ts', '0:/p/readme.md']);
        expect(directories).toEqual(['/p', '/p/src']);
        expect(rows[0]).toMatchObject({ isExpanded: true, lastDescendant: 1, setSize: 2 });
        expect(rows[1]).toMatchObject({ index: 0, parentRow: 0, setSize: 1 });
        expect(rows[2]).toMatchObject({ index: 1, parentRow: undefined });
    });

    it('requests an expanded directory once its parent lists it, before its own listing loads', () => {
        const { directories, rows } = flatten({ '/p': [directory('/p/src')] }, ['/p/src']);

        expect(directories).toEqual(['/p', '/p/src']);
        expect(describeRows(rows)).toEqual(['0:/p/src']);
    });

    it('never requests a stale expanded path its parent no longer lists', () => {
        const { directories } = flatten({ '/p': [file('/p/readme.md')] }, ['/p/gone']);

        expect(directories).toEqual(['/p']);
    });

    it('does not expand a file even when its path is marked expanded', () => {
        const { rows } = flatten({ '/p': [file('/p/readme.md')] }, ['/p/readme.md']);

        expect(rows[0]).toMatchObject({ isExpanded: false, lastDescendant: 0 });
    });

    it('draws the create field, empty notice, and truncation notice as rows of their directory', () => {
        const emptyFolder = { '/p': [directory('/p/empty')], '/p/empty': [] };
        const empty = flatten(emptyFolder, ['/p/empty']).rows;
        const composing = flatten(emptyFolder, ['/p/empty'], {
            composingDirectory: '/p/empty',
        }).rows;
        const truncated = flatten(
            { '/p': { entries: [file('/p/a.ts')], truncated: true } },
            [],
        ).rows;

        expect(describeRows(empty)).toEqual(['0:/p/empty', '1:empty']);
        expect(describeRows(composing)).toEqual(['0:/p/empty', '1:create']);
        expect(describeRows(truncated)).toEqual(['0:/p/a.ts', '0:truncated']);
    });
});

describe('fileTreeNavigationTarget', () => {
    const { rows } = flatten(
        {
            '/p': [directory('/p/src'), file('/p/readme.md')],
            '/p/src': [],
        },
        ['/p/src'],
        { composingDirectory: '/p' },
    );
    // 0: create, 1: /p/src, 2: empty notice, 3: /p/readme.md

    it('steps over rows that cannot take focus', () => {
        expect(fileTreeNavigationTarget(rows, 1, 'next')).toBe(3);
        expect(fileTreeNavigationTarget(rows, 3, 'previous')).toBe(1);
        expect(fileTreeNavigationTarget(rows, 1, 'previous')).toBeUndefined();
    });

    it('resolves the first and last focusable rows', () => {
        expect(fileTreeNavigationTarget(rows, 3, 'first')).toBe(1);
        expect(fileTreeNavigationTarget(rows, 1, 'last')).toBe(3);
    });

    it('moves to the parent directory row', () => {
        const nested = flatten({ '/p': [directory('/p/src')], '/p/src': [file('/p/src/a.ts')] }, [
            '/p/src',
        ]).rows;

        expect(fileTreeNavigationTarget(nested, 1, 'parent')).toBe(0);
        expect(fileTreeNavigationTarget(nested, 0, 'parent')).toBeUndefined();
    });

    it('lands focus past a removed folder, or before the last row', () => {
        const tree = flatten(
            {
                '/p': [directory('/p/src'), file('/p/readme.md')],
                '/p/src': [file('/p/src/a.ts')],
            },
            ['/p/src'],
        ).rows;
        // 0: /p/src, 1: /p/src/a.ts, 2: /p/readme.md

        expect(fileTreeNavigationTarget(tree, 0, 'afterRemoval')).toBe(2);
        expect(fileTreeNavigationTarget(tree, 2, 'afterRemoval')).toBe(1);
    });
});

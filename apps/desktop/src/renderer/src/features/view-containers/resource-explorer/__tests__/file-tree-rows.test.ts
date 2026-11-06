import type { FileEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { FlattenFileTreeInput } from '../file-tree-rows';
import {
    fileTreeNavigationTarget,
    fileTreeTypeAheadTarget,
    flattenFileTree,
} from '../file-tree-rows';

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

    it('steps into an expanded folder only when it has an entry', () => {
        const tree = flatten(
            {
                '/p': [directory('/p/empty'), directory('/p/src'), file('/p/readme.md')],
                '/p/empty': [],
                '/p/src': [file('/p/src/a.ts')],
            },
            ['/p/empty', '/p/src'],
            { composingDirectory: '/p/src' },
        ).rows;
        // 0: /p/empty, 1: empty notice, 2: /p/src, 3: create, 4: /p/src/a.ts, 5: /p/readme.md

        expect(fileTreeNavigationTarget(tree, 0, 'firstChild')).toBeUndefined();
        expect(fileTreeNavigationTarget(tree, 2, 'firstChild')).toBe(4);
        expect(fileTreeNavigationTarget(tree, 5, 'firstChild')).toBeUndefined();
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

describe('fileTreeTypeAheadTarget', () => {
    const { rows } = flatten(
        { '/p': [directory('/p/docs'), file('/p/dune.md'), file('/p/Readme.md')] },
        [],
    );

    it('jumps to the first visible name that starts with the query, ignoring case', () => {
        expect(fileTreeTypeAheadTarget(rows, 0, 'r')).toBe(2);
        expect(fileTreeTypeAheadTarget(rows, 2, 'DU')).toBe(1);
    });

    it('cycles through rows sharing a first letter when one letter repeats', () => {
        expect(fileTreeTypeAheadTarget(rows, 0, 'd')).toBe(1);
        expect(fileTreeTypeAheadTarget(rows, 1, 'dd')).toBe(0);
    });

    it('stays put while a longer query keeps matching the current row', () => {
        expect(fileTreeTypeAheadTarget(rows, 1, 'du')).toBe(1);
    });

    it('finds nothing for an unmatched or empty query', () => {
        expect(fileTreeTypeAheadTarget(rows, 0, 'zz')).toBeUndefined();
        expect(fileTreeTypeAheadTarget(rows, 0, '')).toBeUndefined();
    });
});

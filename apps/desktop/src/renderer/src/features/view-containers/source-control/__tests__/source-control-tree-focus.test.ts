import { describe, expect, it } from 'vitest';

import {
    resolveActiveTreeRowId,
    shouldTreeClaimKeyInTextField,
    treeRowTabIndex,
} from '../source-control-tree-focus';

const rows = [
    'file-history:header',
    'provider:repo-1',
    'group:repo-1:changes',
    'resource:repo-1/src/a.ts',
    'history:repo-1:header',
    'history:repo-1:path',
    'history:repo-1:commit:abc',
    'history:repo-1:load-more',
];

describe('Source Control roving tabindex', () => {
    it('keeps the Tab stop on the focused row while a background refresh replaces the model', () => {
        expect(resolveActiveTreeRowId(rows, 'history:repo-1:commit:abc')).toBe(
            'history:repo-1:commit:abc',
        );
    });

    it('falls back to the first row when the row holding the Tab stop stops being rendered', () => {
        // Collapsing the Commits disclosure drops every row below its header.
        expect(resolveActiveTreeRowId(rows.slice(0, 5), 'history:repo-1:load-more')).toBe(
            'file-history:header',
        );
        expect(resolveActiveTreeRowId(rows, undefined)).toBe('file-history:header');
    });

    it('remembers the position across a render that momentarily has no rows', () => {
        expect(resolveActiveTreeRowId([], 'provider:repo-1')).toBe('provider:repo-1');
        expect(resolveActiveTreeRowId([], undefined)).toBeUndefined();
    });

    it('gives the tree exactly one Tab stop', () => {
        const active = resolveActiveTreeRowId(rows, undefined);
        const tabbable = rows.filter((rowId) => treeRowTabIndex(active, rowId) === 0);
        expect(tabbable).toEqual(['file-history:header']);
        expect(treeRowTabIndex(active, 'history:repo-1:commit:abc')).toBe(-1);
        expect(rows.filter((rowId) => treeRowTabIndex(undefined, rowId) === 0)).toEqual([]);
    });
});

describe('shouldTreeClaimKeyInTextField', () => {
    it('hands the vertical arrows to the tree and everything else to the commit path filter', () => {
        expect(shouldTreeClaimKeyInTextField('ArrowDown')).toBe(true);
        expect(shouldTreeClaimKeyInTextField('ArrowUp')).toBe(true);
        for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'a'])
            expect(shouldTreeClaimKeyInTextField(key)).toBe(false);
    });
});

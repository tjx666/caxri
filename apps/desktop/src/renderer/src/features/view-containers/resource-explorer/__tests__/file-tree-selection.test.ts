import { describe, expect, it } from 'vitest';

import {
    clickSelection,
    outermostPaths,
    pathAfterRemoval,
    selectionActionPaths,
    selectPath,
    selectPaths,
    selectRange,
    toggleSelectedPath,
} from '../file-tree-selection';

const rows = ['/p/a', '/p/a/x.ts', '/p/b.ts', '/p/c.ts', '/p/d.ts'];
const plain = { metaKey: false, shiftKey: false };
const command = { metaKey: true, shiftKey: false };
const shift = { metaKey: false, shiftKey: true };

describe('clickSelection', () => {
    it('opens on a plain click and selects the row alone', () => {
        const current = selectPaths(['/p/b.ts', '/p/c.ts']);
        expect(clickSelection(current, '/p/d.ts', plain, rows)).toEqual({
            isActivating: true,
            selection: selectPath('/p/d.ts'),
        });
    });

    it('builds a selection with Cmd without opening anything, and Cmd-click again removes a row', () => {
        let { isActivating, selection } = clickSelection(
            selectPath('/p/b.ts'),
            '/p/d.ts',
            command,
            rows,
        );
        expect(isActivating).toBe(false);
        expect(selection).toEqual({
            anchor: '/p/d.ts',
            lead: '/p/d.ts',
            paths: ['/p/b.ts', '/p/d.ts'],
        });

        ({ selection } = clickSelection(selection, '/p/d.ts', command, rows));
        expect(selection).toEqual({ anchor: '/p/d.ts', lead: '/p/b.ts', paths: ['/p/b.ts'] });
    });

    it('selects the visible rows between the anchor and a Shift-clicked row, in either direction', () => {
        const anchored = selectPath('/p/c.ts');
        expect(clickSelection(anchored, '/p/a', shift, rows).selection).toEqual({
            anchor: '/p/c.ts',
            lead: '/p/a',
            paths: ['/p/a', '/p/a/x.ts', '/p/b.ts', '/p/c.ts'],
        });
        expect(clickSelection(anchored, '/p/d.ts', shift, rows)).toEqual({
            isActivating: false,
            selection: { anchor: '/p/c.ts', lead: '/p/d.ts', paths: ['/p/c.ts', '/p/d.ts'] },
        });
    });
});

describe('selectRange', () => {
    it('resizes one range around the same anchor and drops rows a Cmd-click added outside it', () => {
        const withExtra = toggleSelectedPath(
            selectRange(selectPath('/p/b.ts'), '/p/d.ts', rows),
            '/p/a',
        );
        const resized = selectRange({ ...withExtra!, anchor: '/p/b.ts' }, '/p/c.ts', rows);
        expect(resized.paths).toEqual(['/p/b.ts', '/p/c.ts']);
    });

    it('starts at the clicked row when there is no anchor or it is no longer visible', () => {
        expect(selectRange(undefined, '/p/c.ts', rows)).toEqual(selectPath('/p/c.ts'));
        expect(selectRange(selectPath('/p/gone.ts'), '/p/c.ts', rows)).toEqual(
            selectPath('/p/c.ts'),
        );
    });
});

describe('toggleSelectedPath', () => {
    it('clears the selection when its only row is removed', () => {
        expect(toggleSelectedPath(selectPath('/p/b.ts'), '/p/b.ts')).toBeUndefined();
    });

    it('keeps the lead when another row is removed', () => {
        const selection = selectPaths(['/p/b.ts', '/p/c.ts', '/p/d.ts'], '/p/c.ts');
        expect(toggleSelectedPath(selection, '/p/d.ts')?.lead).toBe('/p/c.ts');
    });
});

describe('selectPaths', () => {
    it('dedupes and falls back to the last path when the lead is not among them', () => {
        expect(selectPaths(['/p/b.ts', '/p/c.ts', '/p/b.ts'], '/p/z.ts')).toEqual({
            anchor: '/p/b.ts',
            lead: '/p/c.ts',
            paths: ['/p/b.ts', '/p/c.ts'],
        });
        expect(() => selectPaths([])).toThrow();
    });
});

describe('selectionActionPaths', () => {
    const selection = selectPaths(['/p/b.ts', '/p/c.ts']);

    it('acts on the whole selection from one of its rows, and on the row alone from outside it', () => {
        expect(selectionActionPaths(selection, '/p/c.ts')).toEqual(['/p/b.ts', '/p/c.ts']);
        expect(selectionActionPaths(selection, '/p/d.ts')).toEqual(['/p/d.ts']);
        expect(selectionActionPaths(undefined, '/p/d.ts')).toEqual(['/p/d.ts']);
    });
});

describe('pathAfterRemoval', () => {
    it('moves to the first surviving row below the removed ones, skipping a removed folder’s children', () => {
        expect(pathAfterRemoval(rows, ['/p/a', '/p/c.ts'])).toBe('/p/d.ts');
        expect(pathAfterRemoval(rows, ['/p/a'])).toBe('/p/b.ts');
    });

    it('falls back to the nearest surviving row above, and to nothing when no row survives', () => {
        expect(pathAfterRemoval(rows, ['/p/c.ts', '/p/d.ts'])).toBe('/p/b.ts');
        expect(pathAfterRemoval(['/p/b.ts'], ['/p/b.ts'])).toBeUndefined();
        expect(pathAfterRemoval(rows, ['/p/gone.ts'])).toBeUndefined();
    });
});

describe('outermostPaths', () => {
    it('drops entries inside another selected folder but keeps a sibling with a shared prefix', () => {
        expect(outermostPaths(['/p/a/x.ts', '/p/a', '/p/ab.ts'])).toEqual(['/p/a', '/p/ab.ts']);
    });
});

import { describe, expect, it } from 'vitest';

import {
    activeLayoutPath,
    addEditorPath,
    canSplitEditorPath,
    createEditorLayout,
    deriveDefaultEditorLayout,
    findPathGroupId,
    firstLayoutPath,
    listLayoutPaths,
    moveEditorPath,
    remapEditorLayoutPaths,
    removeEditorPath,
    removeEditorPathsUnder,
    resizeSplit,
    selectEditorPath,
    splitEditorPath,
} from '../editor-layout';

const ids = (() => {
    let value = 0;
    return () => `node-${++value}`;
})();

describe('Editor layout reducer', () => {
    it('splits right and down while preserving every live path', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        layout = splitEditorPath(layout, '/repo/b.ts', layout.activeGroupId!, 'right', ids);
        const secondGroupId = layout.activeGroupId!;
        layout = splitEditorPath(layout, '/repo/c.ts', secondGroupId, 'down', ids);

        expect(listLayoutPaths(layout)).toEqual(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);
        expect(firstLayoutPath(layout)).toBe('/repo/a.ts');
        expect(activeLayoutPath(layout)).toBe('/repo/c.ts');
        expect(layout.root).toMatchObject({
            type: 'split',
            direction: 'horizontal',
            second: { type: 'split', direction: 'vertical' },
        });
    });

    it('splits left/up by placing the new group before the target', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        const firstGroupId = layout.activeGroupId!;
        layout = splitEditorPath(layout, '/repo/b.ts', firstGroupId, 'left', ids);

        expect(layout.root).toMatchObject({
            type: 'split',
            direction: 'horizontal',
            first: { paths: ['/repo/b.ts'] },
            second: { id: firstGroupId, paths: ['/repo/a.ts'] },
        });
    });

    it('splits a single-tab group into two side-by-side views of the same file (VS Code parity)', () => {
        const layout = createEditorLayout('/repo/a.ts', ids);
        const result = splitEditorPath(layout, '/repo/a.ts', layout.activeGroupId!, 'right', ids);

        expect(result).not.toBe(layout);
        expect(listLayoutPaths(result)).toEqual(['/repo/a.ts', '/repo/a.ts']);
        expect(result.activeGroupId).not.toBe(layout.activeGroupId);
    });

    it('allows the same path to be split open in two different groups at once', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        layout = addEditorPath(layout, '/repo/b.ts', layout.activeGroupId, ids);
        const firstGroupId = layout.activeGroupId!;
        layout = splitEditorPath(layout, '/repo/a.ts', firstGroupId, 'right', ids);

        // `/repo/a.ts` now lives in both groups; VS Code allows the same file open side by side.
        expect(listLayoutPaths(layout).filter((path) => path === '/repo/a.ts')).toHaveLength(2);
    });

    it('moves a path between groups and collapses an empty source group', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        const firstGroupId = layout.activeGroupId!;
        layout = splitEditorPath(layout, '/repo/b.ts', firstGroupId, 'right', ids);
        const secondGroupId = layout.activeGroupId!;

        layout = moveEditorPath(layout, '/repo/a.ts', firstGroupId, secondGroupId);

        expect(layout.root).toMatchObject({
            type: 'group',
            id: secondGroupId,
            paths: ['/repo/b.ts', '/repo/a.ts'],
            activePath: '/repo/a.ts',
        });
    });

    it('moving a path within its own group only activates it', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        const groupId = layout.activeGroupId!;
        layout = addEditorPath(layout, '/repo/b.ts', groupId, ids);
        layout = moveEditorPath(layout, '/repo/a.ts', groupId, groupId);

        expect(layout.root).toMatchObject({
            paths: ['/repo/a.ts', '/repo/b.ts'],
            activePath: '/repo/a.ts',
        });
    });

    it('selects an existing path, adds a missing path, and clamps split ratios', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        const firstGroupId = layout.activeGroupId!;
        layout = splitEditorPath(layout, '/repo/b.ts', firstGroupId, 'right', ids);
        const splitId = layout.root!.id;
        layout = selectEditorPath(layout, '/repo/a.ts');
        layout = addEditorPath(layout, '/repo/c.ts', layout.activeGroupId, ids);
        layout = resizeSplit(layout, splitId, 0.99);

        expect(layout.activeGroupId).toBe(firstGroupId);
        expect(listLayoutPaths(layout)).toEqual(['/repo/a.ts', '/repo/c.ts', '/repo/b.ts']);
        expect(layout.root).toMatchObject({ type: 'split', ratio: 0.85 });
    });

    it('adding a path already open in the target group only activates it, without duplicating it', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        const groupId = layout.activeGroupId!;
        layout = addEditorPath(layout, '/repo/b.ts', groupId, ids);
        layout = addEditorPath(layout, '/repo/a.ts', groupId, ids);

        expect(layout.root).toMatchObject({
            paths: ['/repo/a.ts', '/repo/b.ts'],
            activePath: '/repo/a.ts',
        });
    });

    it('removes only the empty group when its final path closes', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        layout = splitEditorPath(layout, '/repo/b.ts', layout.activeGroupId!, 'right', ids);

        layout = removeEditorPath(layout, '/repo/b.ts');

        expect(layout.root).toMatchObject({ type: 'group', paths: ['/repo/a.ts'] });
        expect(layout.activeGroupId).toBe(layout.root!.id);
    });

    it('falls back the active group when the active group disappears', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        layout = splitEditorPath(layout, '/repo/b.ts', layout.activeGroupId!, 'right', ids);
        const activeGroupId = layout.activeGroupId!;

        layout = removeEditorPath(layout, '/repo/b.ts');

        expect(layout.activeGroupId).not.toBe(activeGroupId);
        expect(layout.activeGroupId).toBe(layout.root!.id);
    });

    it('removing a path present in two groups clears every occurrence, not just the first', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        const firstGroupId = layout.activeGroupId!;
        layout = addEditorPath(layout, '/repo/b.ts', firstGroupId, ids);
        layout = splitEditorPath(layout, '/repo/a.ts', firstGroupId, 'right', ids);
        const secondGroupId = layout.activeGroupId!;
        layout = addEditorPath(layout, '/repo/c.ts', secondGroupId, ids);

        layout = removeEditorPath(layout, '/repo/a.ts');

        expect(listLayoutPaths(layout)).toEqual(['/repo/b.ts', '/repo/c.ts']);
    });

    it('preferring the active group, findPathGroupId resolves a path duplicated across groups', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        const firstGroupId = layout.activeGroupId!;
        layout = addEditorPath(layout, '/repo/b.ts', firstGroupId, ids);
        layout = splitEditorPath(layout, '/repo/a.ts', firstGroupId, 'right', ids);
        const secondGroupId = layout.activeGroupId!;

        expect(findPathGroupId(layout, '/repo/a.ts')).toBe(secondGroupId);
        layout = selectEditorPath(layout, '/repo/a.ts');
        expect(layout.activeGroupId).toBe(secondGroupId);
    });

    it('selectEditorPath can pin a duplicated path to a non-active group', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        const firstGroupId = layout.activeGroupId!;
        layout = addEditorPath(layout, '/repo/b.ts', firstGroupId, ids);
        layout = splitEditorPath(layout, '/repo/a.ts', firstGroupId, 'right', ids);

        layout = selectEditorPath(layout, '/repo/a.ts', firstGroupId);

        expect(layout.activeGroupId).toBe(firstGroupId);
        expect(activeLayoutPath(layout)).toBe('/repo/a.ts');
    });

    it('canSplitEditorPath allows growth until the group cap, then refuses and splits become no-ops', () => {
        let layout = createEditorLayout('/repo/a.ts', ids);
        expect(canSplitEditorPath(layout, layout.activeGroupId!)).toBe(true);

        for (let index = 1; index < 8; index += 1) {
            layout = splitEditorPath(layout, '/repo/a.ts', layout.activeGroupId!, 'right', ids);
        }
        expect(listLayoutPaths(layout)).toHaveLength(8);

        expect(canSplitEditorPath(layout, layout.activeGroupId!)).toBe(false);
        const overCap = splitEditorPath(layout, '/repo/a.ts', layout.activeGroupId!, 'right', ids);
        expect(overCap).toBe(layout);
    });

    it('remaps every path under a renamed directory, including duplicated occurrences', () => {
        let layout = createEditorLayout('/repo/src/a.ts', ids);
        layout = addEditorPath(layout, '/repo/other.ts', layout.activeGroupId, ids);
        layout = splitEditorPath(
            layout,
            '/repo/src/a.ts',
            findPathGroupId(layout, '/repo/other.ts')!,
            'right',
            ids,
        );

        layout = remapEditorLayoutPaths(layout, '/repo/src', '/repo/lib');

        expect(listLayoutPaths(layout).toSorted((a, b) => a.localeCompare(b))).toEqual([
            '/repo/lib/a.ts',
            '/repo/lib/a.ts',
            '/repo/other.ts',
        ]);
    });

    it('removes every path at or below a trashed directory, collapsing empty groups', () => {
        let layout = createEditorLayout('/repo/src/a.ts', ids);
        layout = addEditorPath(layout, '/repo/other.ts', layout.activeGroupId, ids);
        const otherGroupId = layout.activeGroupId!;
        layout = splitEditorPath(layout, '/repo/src/b.ts', otherGroupId, 'right', ids);

        layout = removeEditorPathsUnder(layout, '/repo/src');

        expect(listLayoutPaths(layout)).toEqual(['/repo/other.ts']);
        expect(layout.root).toMatchObject({ type: 'group', paths: ['/repo/other.ts'] });
    });

    it('derives a single-group default layout from legacy openTabs, honoring the active tab', () => {
        const openTabs = [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }];
        const layout = deriveDefaultEditorLayout(
            openTabs,
            { kind: 'editor', path: '/repo/b.ts' },
            ids,
        );

        expect(layout.root).toMatchObject({
            type: 'group',
            paths: ['/repo/a.ts', '/repo/b.ts'],
            activePath: '/repo/b.ts',
        });
        expect(layout.activeGroupId).toBe(layout.root!.id);
    });

    it('derives an empty layout with no openTabs and falls back to the first tab otherwise', () => {
        expect(deriveDefaultEditorLayout([], undefined, ids)).toEqual({});

        const layout = deriveDefaultEditorLayout(
            [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }],
            { kind: 'terminal', terminalId: 'terminal-1' },
            ids,
        );
        expect(layout.root).toMatchObject({ activePath: '/repo/a.ts' });
    });
});

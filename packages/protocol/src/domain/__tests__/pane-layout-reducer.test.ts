import type { PaneLayout, PaneResource } from '@caxri/protocol';
import { MAX_PANE_LAYOUT_PANES, MAX_TABS_PER_PANE, paneLayoutSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    activePane,
    activeTab,
    addPaneTerminalSilently,
    adjacentPaneId,
    closeTab,
    closeTabs,
    createPaneLayout,
    findPane,
    findResourceTabs,
    findTab,
    listPanes,
    listPaneTerminalIds,
    moveTab,
    openResource,
    paneSplitBlockedReason,
    paneTabIdsToClose,
    pinPaneTab,
    remapPaneLayoutPaths,
    removePaneTerminal,
    resizeSplit,
    selectTab,
    splitTabIntoPane,
} from '../pane-layout-reducer';

/**
 * Deterministic ids keep the assertions readable and make every generated identity visible in the test.
 */
function ids(): () => string {
    let next = 0;
    return () => `id-${++next}`;
}

const terminal = (terminalId: string): PaneResource => ({ kind: 'terminal', terminalId });
const file = (path: string): PaneResource => ({ kind: 'file', path });

/**
 * Every reducer result must still satisfy the persisted contract; an operation that produces an unparseable tree would
 * only fail later, at the Runtime boundary.
 */
function valid(layout: PaneLayout): PaneLayout {
    const result = paneLayoutSchema.safeParse(layout);
    expect(result.error?.issues[0]?.message, 'reducer produced an invalid layout').toBeUndefined();
    return layout;
}

function tabResources(layout: PaneLayout, paneId: string): string[] {
    const pane = findPane(layout, paneId);
    return (pane?.tabs ?? []).map((tab) =>
        tab.resource.kind === 'terminal' ? tab.resource.terminalId : `${tab.resource.kind}`,
    );
}

describe('pane layout reducer', () => {
    it('starts as one empty pane so every command has somewhere to open into', () => {
        const layout = valid(createPaneLayout(undefined, ids()));
        expect(listPanes(layout)).toHaveLength(1);
        expect(activeTab(layout)).toBeUndefined();
        expect(layout.activePaneId).toBe(activePane(layout).id);
    });

    it('opens Terminals and documents into the same pane through one path', () => {
        const id = ids();
        let layout = createPaneLayout(terminal('terminal-1'), id);
        layout = valid(openResource(layout, file('a.ts'), {}, id));
        expect(tabResources(layout, activePane(layout).id)).toEqual(['terminal-1', 'file']);
        expect(activeTab(layout)?.resource).toEqual(file('a.ts'));
    });

    it('reveals a resource already open in the target pane instead of opening it twice', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), {}, id);
        const before = activePane(layout).tabs.length;
        layout = valid(openResource(layout, file('a.ts'), {}, id));
        expect(activePane(layout).tabs).toHaveLength(before);
        expect(activeTab(layout)?.resource).toEqual(file('a.ts'));
    });

    it('reveals a Terminal that lives in another pane rather than cloning its PTY', () => {
        const id = ids();
        let layout = createPaneLayout(terminal('terminal-1'), id);
        layout = openResource(layout, file('a.ts'), {}, id);
        const home = activePane(layout).id;
        const documentTab = activePane(layout).tabs[1];
        layout = splitTabIntoPane(layout, documentTab.id, home, 'right', id);
        const right = activePane(layout).id;
        expect(right).not.toBe(home);

        layout = valid(openResource(layout, terminal('terminal-1'), { paneId: right }, id));
        expect(findResourceTabs(layout, terminal('terminal-1'))).toHaveLength(1);
        expect(activePane(layout).id).toBe(home);
    });

    it('lets a document take a second occurrence when duplication is asked for', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), {}, id);
        const [firstTab] = activePane(layout).tabs;
        layout = splitTabIntoPane(layout, firstTab.id, activePane(layout).id, 'down', id);

        layout = valid(openResource(layout, file('b.ts'), { duplicate: true }, id));
        const occurrences = findResourceTabs(layout, file('b.ts'));
        expect(occurrences).toHaveLength(2);
        expect(new Set(occurrences.map((occurrence) => occurrence.tab.id)).size).toBe(2);
        expect(new Set(occurrences.map((occurrence) => occurrence.pane.id)).size).toBe(2);
    });

    it('replaces the preview tab instead of stacking previews', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), { preview: true }, id);
        layout = valid(openResource(layout, file('c.ts'), { preview: true }, id));
        expect(activePane(layout).tabs).toHaveLength(2);
        expect(activeTab(layout)?.resource).toEqual(file('c.ts'));
    });

    it('pins the preview tab when the same file is opened again without preview', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), { preview: true }, id);
        const previewId = activeTab(layout)?.id;
        layout = valid(openResource(layout, file('b.ts'), {}, id));
        expect(activePane(layout).tabs).toHaveLength(2);
        expect(activeTab(layout)?.id).toBe(previewId);
        expect(activeTab(layout)?.preview).toBeUndefined();
    });

    it('keeps the preview tab as a preview when previewed again', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), { preview: true }, id);
        layout = valid(openResource(layout, file('b.ts'), { preview: true }, id));
        expect(activeTab(layout)?.preview).toBe(true);
    });

    it('activates the tab that slid into the closed one place', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), {}, id);
        layout = openResource(layout, file('c.ts'), {}, id);
        const [, middle] = activePane(layout).tabs;

        layout = valid(closeTab(selectTab(layout, middle.id), middle.id));
        expect(activeTab(layout)?.resource).toEqual(file('c.ts'));
    });

    it('collapses a pane when its last tab closes, and keeps the last pane alive', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), {}, id);
        const [firstTab] = activePane(layout).tabs;
        layout = splitTabIntoPane(layout, firstTab.id, activePane(layout).id, 'right', id);
        expect(listPanes(layout)).toHaveLength(2);

        layout = valid(closeTab(layout, firstTab.id));
        expect(listPanes(layout)).toHaveLength(1);
        expect(layout.activePaneId).toBe(activePane(layout).id);

        const [remaining] = activePane(layout).tabs;
        layout = valid(closeTab(layout, remaining.id));
        expect(listPanes(layout)).toHaveLength(1);
        expect(activePane(layout).tabs).toEqual([]);
    });

    it('moves an occurrence between panes without duplicating it', () => {
        const id = ids();
        let layout = createPaneLayout(terminal('terminal-1'), id);
        layout = openResource(layout, terminal('terminal-2'), {}, id);
        const source = activePane(layout).id;
        const [movedTab] = activePane(layout).tabs;
        layout = splitTabIntoPane(layout, movedTab.id, source, 'right', id);
        const target = activePane(layout).id;

        const [stayingTab] = findPane(layout, source)!.tabs;
        layout = valid(moveTab(layout, stayingTab.id, target, 0));
        expect(tabResources(layout, target)).toEqual(['terminal-2', 'terminal-1']);
        expect(findTab(layout, stayingTab.id)?.pane.id).toBe(target);
        // The emptied source pane collapsed into its sibling.
        expect(listPanes(layout)).toHaveLength(1);
    });

    it('reorders inside one pane when the move targets that same pane', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), {}, id);
        layout = openResource(layout, file('c.ts'), {}, id);
        const paneId = activePane(layout).id;
        const last = activePane(layout).tabs[2];

        layout = valid(moveTab(layout, last.id, paneId, 0));
        expect(activePane(layout).tabs[0].id).toBe(last.id);
        expect(activePane(layout).tabs).toHaveLength(3);
    });

    it('refuses to split a pane only tab off itself', () => {
        const id = ids();
        const layout = createPaneLayout(file('a.ts'), id);
        const [onlyTab] = activePane(layout).tabs;
        expect(splitTabIntoPane(layout, onlyTab.id, activePane(layout).id, 'right', id)).toBe(
            layout,
        );
    });

    /**
     * The Split menu items read this instead of clicking to find out: a no-op split returns the identical layout, which
     * an enabled menu item cannot distinguish from a successful edit.
     */
    it('reports why a split would do nothing before it is attempted', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        const [onlyTab] = activePane(layout).tabs;
        expect(paneSplitBlockedReason(layout, onlyTab.id, activePane(layout).id)).toBe('only-tab');
        expect(paneSplitBlockedReason(layout, 'missing', activePane(layout).id)).toBe('missing');
        expect(paneSplitBlockedReason(layout, onlyTab.id, 'missing')).toBe('missing');

        layout = openResource(layout, file('b.ts'), {}, id);
        expect(paneSplitBlockedReason(layout, onlyTab.id, activePane(layout).id)).toBeUndefined();

        // Filling the layout to its pane ceiling blocks every remaining split, tab count notwithstanding.
        while (listPanes(layout).length < MAX_PANE_LAYOUT_PANES) {
            layout = openResource(layout, file(`pane-${listPanes(layout).length}.ts`), {}, id);
            const [head] = activePane(layout).tabs;
            layout = splitTabIntoPane(layout, head.id, activePane(layout).id, 'right', id);
        }
        expect(listPanes(layout)).toHaveLength(MAX_PANE_LAYOUT_PANES);
        layout = openResource(layout, file('extra.ts'), {}, id);
        const [crowded] = activePane(layout).tabs;
        expect(paneSplitBlockedReason(layout, crowded.id, activePane(layout).id)).toBe(
            'pane-limit',
        );
    });

    it('clamps a split ratio to the persisted bounds', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), {}, id);
        const [firstTab] = activePane(layout).tabs;
        layout = splitTabIntoPane(layout, firstTab.id, activePane(layout).id, 'right', id);
        const splitId = layout.root.type === 'split' ? layout.root.id : '';

        expect(valid(resizeSplit(layout, splitId, 0.99)).root).toMatchObject({ ratio: 0.85 });
        expect(valid(resizeSplit(layout, splitId, 0)).root).toMatchObject({ ratio: 0.15 });
    });

    it('pins one occurrence of a preview without pinning the other', () => {
        const id = ids();
        let layout = createPaneLayout(file('b.ts'), id);
        layout = openResource(layout, file('a.ts'), { preview: true }, id);
        const [anchor, firstPreview] = activePane(layout).tabs;
        layout = splitTabIntoPane(layout, anchor.id, activePane(layout).id, 'right', id);
        layout = openResource(layout, file('a.ts'), { preview: true }, id);
        const secondPreview = activePane(layout).tabs.at(-1)!;

        const pinned = valid(pinPaneTab(layout, firstPreview.id));
        expect(findTab(pinned, firstPreview.id)?.tab.preview).toBeUndefined();
        expect(findTab(pinned, secondPreview.id)?.tab.preview).toBe(true);
        expect(pinPaneTab(pinned, firstPreview.id)).toBe(pinned);
    });

    it('closes tab families inside the owning pane only', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), {}, id);
        layout = openResource(layout, file('c.ts'), {}, id);
        const [first, second] = activePane(layout).tabs;
        // The same document opened in a second pane must survive every pane-local close mode.
        layout = splitTabIntoPane(layout, second.id, activePane(layout).id, 'right', id);
        const remainingPaneId = findTab(layout, first.id)!.pane.id;

        expect(paneTabIdsToClose(layout, first.id, 'one')).toEqual([first.id]);
        expect(paneTabIdsToClose(layout, first.id, 'others')).toHaveLength(1);
        expect(paneTabIdsToClose(layout, first.id, 'right')).toHaveLength(1);
        expect(paneTabIdsToClose(layout, first.id, 'all')).toHaveLength(2);
        expect(paneTabIdsToClose(layout, 'missing', 'all')).toEqual([]);
        const closed = valid(closeTabs(layout, paneTabIdsToClose(layout, first.id, 'all')));
        expect(findPane(closed, remainingPaneId)).toBeUndefined();
        expect(findTab(closed, second.id)).toBeDefined();
    });

    it('drops a closed Terminal wherever it was placed', () => {
        const id = ids();
        let layout = createPaneLayout(terminal('terminal-1'), id);
        layout = openResource(layout, file('a.ts'), {}, id);

        const removed = valid(removePaneTerminal(layout, 'terminal-1'));
        expect(listPaneTerminalIds(removed)).toEqual([]);
        expect(listPaneTerminalIds(layout)).toEqual(['terminal-1']);
        expect(removePaneTerminal(removed, 'terminal-1')).toBe(removed);
    });

    it('remaps document paths after a Project root move and leaves Terminals alone', () => {
        const id = ids();
        let layout = createPaneLayout(terminal('terminal-1'), id);
        layout = openResource(layout, file('/old/a.ts'), {}, id);
        layout = openResource(layout, file('/old/b.ts'), {}, id);

        const remapped = valid(
            remapPaneLayoutPaths(layout, (path) => path.replace('/old/', '/new/')),
        );
        expect(activePane(remapped).tabs.map((tab) => tab.resource)).toEqual([
            terminal('terminal-1'),
            file('/new/a.ts'),
            file('/new/b.ts'),
        ]);
        expect(remapPaneLayoutPaths(remapped, (path) => path)).toBe(remapped);
    });

    it('merges occurrences a Replace remaps onto the same target path', () => {
        const id = ids();
        let layout = createPaneLayout(file('/old/source.ts'), id);
        layout = openResource(layout, file('/dest/source.ts'), {}, id);
        const [movedTab, targetTab] = activePane(layout).tabs;
        layout = selectTab(layout, movedTab.id);

        const remapped = valid(
            remapPaneLayoutPaths(layout, (path) =>
                path === '/old/source.ts' ? '/dest/source.ts' : path,
            ),
        );
        const occurrences = findResourceTabs(remapped, file('/dest/source.ts'));
        expect(occurrences).toHaveLength(1);
        expect(occurrences[0]?.tab.id).toBe(movedTab.id);
        expect(activePane(remapped).activeTabId).toBe(movedTab.id);
        expect(findTab(remapped, targetTab.id)).toBeUndefined();
    });

    it('refuses to grow a pane past the tab cap', () => {
        const id = ids();
        let layout = createPaneLayout(file('file-0.ts'), id);
        for (let index = 1; index < MAX_TABS_PER_PANE; index++) {
            layout = valid(openResource(layout, file(`file-${index}.ts`), {}, id));
        }
        expect(activePane(layout).tabs).toHaveLength(MAX_TABS_PER_PANE);

        const atCap = openResource(layout, file('one-too-many.ts'), {}, id);
        expect(atCap).toBe(layout);
    });

    it('refuses to grow the tree past the pane cap', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        for (let index = 0; index < MAX_PANE_LAYOUT_PANES - 1; index++) {
            layout = openResource(layout, file(`extra-${index}.ts`), {}, id);
            const opened = activeTab(layout)!;
            layout = valid(splitTabIntoPane(layout, opened.id, activePane(layout).id, 'right', id));
        }
        expect(listPanes(layout)).toHaveLength(MAX_PANE_LAYOUT_PANES);

        layout = openResource(layout, file('overflow.ts'), {}, id);
        const overflowTab = activeTab(layout)!;
        const atCap = splitTabIntoPane(layout, overflowTab.id, activePane(layout).id, 'right', id);
        expect(atCap).toBe(layout);
    });

    it('adds a Terminal silently without activating it', () => {
        const id = ids();
        const layout = createPaneLayout(terminal('term-1'), id);
        const added = valid(addPaneTerminalSilently(layout, 'term-2', id));
        expect(tabResources(added, activePane(added).id)).toEqual(['term-1', 'term-2']);
        expect(activeTab(added)?.resource).toEqual(terminal('term-1'));
    });

    it('does not duplicate a Terminal that already has an occurrence when adding it silently', () => {
        const id = ids();
        const layout = createPaneLayout(terminal('term-1'), id);
        const added = addPaneTerminalSilently(layout, 'term-1', id);
        expect(added).toBe(layout);
        expect(findResourceTabs(added, terminal('term-1'))).toHaveLength(1);
    });

    it('ignores operations that name something the layout does not hold', () => {
        const id = ids();
        const layout = createPaneLayout(file('a.ts'), id);
        expect(closeTab(layout, 'missing')).toBe(layout);
        expect(selectTab(layout, 'missing')).toBe(layout);
        expect(moveTab(layout, 'missing', activePane(layout).id)).toBe(layout);
        expect(splitTabIntoPane(layout, 'missing', activePane(layout).id, 'right', id)).toBe(
            layout,
        );
    });
});

describe('adjacentPaneId', () => {
    it('reports no neighbor for a single-pane layout in any direction', () => {
        const id = ids();
        const layout = createPaneLayout(file('a.ts'), id);
        const paneId = activePane(layout).id;
        expect(adjacentPaneId(layout, paneId, 'left')).toBeUndefined();
        expect(adjacentPaneId(layout, paneId, 'right')).toBeUndefined();
        expect(adjacentPaneId(layout, paneId, 'up')).toBeUndefined();
        expect(adjacentPaneId(layout, paneId, 'down')).toBeUndefined();
    });

    /**
     * Builds a three-pane layout shaped like an L: `topLeft` and `bottomLeft` stacked in a vertical split, that stack
     * split horizontally against `right`, which spans the full height of the right column.
     *
     *     +----------+----------+
     *     | topLeft  |          |
     *     +----------+  right   |
     *     |bottomLeft|          |
     *     +----------+----------+
     */
    function buildLShapedLayout(): {
        layout: PaneLayout;
        topLeft: string;
        bottomLeft: string;
        right: string;
    } {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        const topLeft = activePane(layout).id;
        layout = openResource(layout, file('b.ts'), { paneId: topLeft }, id);
        const rightTab = activeTab(layout)!;
        layout = valid(splitTabIntoPane(layout, rightTab.id, topLeft, 'right', id));
        const right = activePane(layout).id;
        layout = openResource(layout, file('c.ts'), { paneId: topLeft }, id);
        const bottomTab = activeTab(layout)!;
        layout = valid(splitTabIntoPane(layout, bottomTab.id, topLeft, 'down', id));
        const bottomLeft = activePane(layout).id;
        return { layout, topLeft, bottomLeft, right };
    }

    it('finds the pane across a horizontal split', () => {
        const { layout, topLeft, right } = buildLShapedLayout();
        expect(adjacentPaneId(layout, topLeft, 'right')).toBe(right);
        expect(adjacentPaneId(layout, right, 'left')).toBe(topLeft);
    });

    it('finds the pane across a vertical split', () => {
        const { layout, topLeft, bottomLeft } = buildLShapedLayout();
        expect(adjacentPaneId(layout, topLeft, 'down')).toBe(bottomLeft);
        expect(adjacentPaneId(layout, bottomLeft, 'up')).toBe(topLeft);
    });

    it('reaches the full-height pane from either half of the split column beside it', () => {
        const { layout, bottomLeft, right } = buildLShapedLayout();
        expect(adjacentPaneId(layout, bottomLeft, 'right')).toBe(right);
    });

    it('breaks a tie between equally overlapping candidates by tree order', () => {
        const { layout, topLeft, right } = buildLShapedLayout();
        // `right` spans both `topLeft` and `bottomLeft` with an identical 50% perpendicular overlap; `topLeft` comes
        // first in tree order and wins the tie.
        expect(adjacentPaneId(layout, right, 'left')).toBe(topLeft);
    });

    it('reports no neighbor past the edge of the Workbench', () => {
        const { layout, topLeft, bottomLeft, right } = buildLShapedLayout();
        expect(adjacentPaneId(layout, topLeft, 'left')).toBeUndefined();
        expect(adjacentPaneId(layout, topLeft, 'up')).toBeUndefined();
        expect(adjacentPaneId(layout, bottomLeft, 'down')).toBeUndefined();
        expect(adjacentPaneId(layout, right, 'right')).toBeUndefined();
        expect(adjacentPaneId(layout, right, 'up')).toBeUndefined();
        expect(adjacentPaneId(layout, right, 'down')).toBeUndefined();
    });

    it('is undefined for an unknown pane id', () => {
        const { layout } = buildLShapedLayout();
        expect(adjacentPaneId(layout, 'missing', 'left')).toBeUndefined();
    });
});

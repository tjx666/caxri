import { describe, expect, it } from 'vitest';

import type { PaneLayout, PaneResource } from '../ipc/pane-layout';
import { paneLayoutSchema } from '../ipc/pane-layout';
import {
    activePane,
    activeTab,
    closeTab,
    createPaneLayout,
    findPane,
    findResourceTabs,
    findTab,
    listPanes,
    moveTab,
    openResource,
    resizeSplit,
    selectTab,
    splitTabIntoPane,
} from '../pane-layout';

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
        layout = splitTabIntoPane(layout, documentTab.id, home, 'horizontal', id);
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
        layout = splitTabIntoPane(layout, firstTab.id, activePane(layout).id, 'vertical', id);

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
        layout = splitTabIntoPane(layout, firstTab.id, activePane(layout).id, 'horizontal', id);
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
        layout = splitTabIntoPane(layout, movedTab.id, source, 'horizontal', id);
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
        expect(splitTabIntoPane(layout, onlyTab.id, activePane(layout).id, 'horizontal', id)).toBe(
            layout,
        );
    });

    it('clamps a split ratio to the persisted bounds', () => {
        const id = ids();
        let layout = createPaneLayout(file('a.ts'), id);
        layout = openResource(layout, file('b.ts'), {}, id);
        const [firstTab] = activePane(layout).tabs;
        layout = splitTabIntoPane(layout, firstTab.id, activePane(layout).id, 'horizontal', id);
        const splitId = layout.root.type === 'split' ? layout.root.id : '';

        expect(valid(resizeSplit(layout, splitId, 0.99)).root).toMatchObject({ ratio: 0.85 });
        expect(valid(resizeSplit(layout, splitId, 0)).root).toMatchObject({ ratio: 0.15 });
    });

    it('ignores operations that name something the layout does not hold', () => {
        const id = ids();
        const layout = createPaneLayout(file('a.ts'), id);
        expect(closeTab(layout, 'missing')).toBe(layout);
        expect(selectTab(layout, 'missing')).toBe(layout);
        expect(moveTab(layout, 'missing', activePane(layout).id)).toBe(layout);
        expect(splitTabIntoPane(layout, 'missing', activePane(layout).id, 'horizontal', id)).toBe(
            layout,
        );
    });
});

import type { TreeItemDto } from '@caxri/protocol';
import { MAX_VIEW_TREE_PERSISTED_IDS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    createExtensionTreeState,
    focusTreeItem,
    isTreeItemExpanded,
    isTreeSnapshotReady,
    keyboardTreeRowAction,
    nextTreeSnapshot,
    pointerTreeRowAction,
    reconcileTreeItems,
    replaceTreeChildren,
    serializeExtensionTreeState,
    toggleTreeItem,
    toggleTreeItemSubtree,
    treeSnapshotLoading,
    visibleTreeLoading,
} from '../state';

function item(options: {
    collapsibleState?: TreeItemDto['collapsibleState'];
    command?: boolean;
    handle: string;
    id?: string;
}): TreeItemDto {
    return {
        handle: options.handle,
        ...(options.id && { id: options.id }),
        label: options.id ?? options.handle,
        accessibilityLabel: options.id ?? options.handle,
        collapsibleState: options.collapsibleState ?? 'none',
        ...(options.command && {
            command: { id: 'publisher.command', title: 'Run command' },
        }),
    };
}

describe('extension tree snapshot', () => {
    const repo = item({ handle: 'repo', id: 'repo', collapsibleState: 'expanded' });

    it('keeps the partial first-load tree on screen when the provider resets mid-load', () => {
        const partial = new Map([['root', [repo]]]);
        const loading = new Set(['repo']);
        const shown = nextTreeSnapshot(undefined, 'root', partial, new Map(), loading, false);
        expect(shown).toEqual({ children: partial, errors: new Map(), loading, isComplete: false });

        // The reset clears the working tree and reloads the root.
        const afterReset = nextTreeSnapshot(
            shown,
            'root',
            new Map(),
            new Map(),
            new Set(['root']),
            false,
        );
        expect(afterReset).toBe(shown);
        // The repository row stays, its branch keeps its placeholder, and the root is not redrawn as a skeleton.
        expect(visibleTreeLoading(new Set(['root']), afterReset)).toEqual(new Set(['repo']));
    });

    it('shows the root skeleton only before any of the tree has arrived', () => {
        expect(
            nextTreeSnapshot(undefined, 'root', new Map(), new Map(), new Set(['root']), false),
        ).toBeUndefined();
        expect(visibleTreeLoading(new Set(['root']), undefined)).toEqual(new Set(['root']));
    });

    it('never lets a partial tree replace a complete one', () => {
        const complete = new Map([
            ['root', [repo]],
            ['repo', [item({ handle: 'check' })]],
        ]);
        const errors = new Map<string, string>();
        const settled = nextTreeSnapshot(undefined, 'root', complete, errors, new Set(), true);
        expect(settled?.isComplete).toBe(true);
        expect(
            nextTreeSnapshot(
                settled,
                'root',
                new Map([['root', [repo]]]),
                new Map(),
                new Set(['repo']),
                false,
            ),
        ).toBe(settled);
        expect(nextTreeSnapshot(settled, 'root', complete, errors, new Set(), true)).toBe(settled);
    });
});

describe('extension tree state', () => {
    it('keeps first-expansion and retry feedback while hiding healthy refresh loading', () => {
        expect(
            treeSnapshotLoading(
                new Set(['healthy', 'new-branch', 'retry']),
                new Map([
                    ['healthy', []],
                    ['retry', []],
                ]),
                new Map([['retry', 'Unavailable']]),
            ),
        ).toEqual(new Set(['new-branch', 'retry']));
    });

    it('keeps a refresh unpublished until expanded descendants settle', () => {
        const branch = item({ handle: 'repo', id: 'repo', collapsibleState: 'expanded' });
        const leaf = item({ handle: 'check' });
        const state = reconcileTreeItems(createExtensionTreeState(), [branch]);
        const children = new Map([['root', [branch]]]);
        expect(isTreeSnapshotReady('root', new Map(), new Map(), new Set(['root']), state)).toBe(
            false,
        );
        expect(isTreeSnapshotReady('root', children, new Map(), new Set(), state)).toBe(false);
        children.set('repo', [leaf]);
        expect(isTreeSnapshotReady('root', children, new Map(), new Set(['repo']), state)).toBe(
            false,
        );
        expect(isTreeSnapshotReady('root', children, new Map(), new Set(), state)).toBe(true);
        children.delete('repo');
        expect(
            isTreeSnapshotReady(
                'root',
                children,
                new Map([['repo', 'Unavailable']]),
                new Set(),
                state,
            ),
        ).toBe(true);
        expect(
            isTreeSnapshotReady(
                'root',
                children,
                new Map(),
                new Set(),
                toggleTreeItem(state, branch),
            ),
        ).toBe(true);
    });

    it('applies provider-expanded once and preserves a later user collapse across refresh', () => {
        const branch = item({
            collapsibleState: 'expanded',
            handle: 'generation-1',
            id: 'stable-branch',
        });
        let state = reconcileTreeItems(createExtensionTreeState(), [branch]);
        expect(isTreeItemExpanded(state, branch)).toBe(true);

        state = toggleTreeItem(state, branch);
        const replacement = item({
            collapsibleState: 'expanded',
            handle: 'generation-2',
            id: 'stable-branch',
        });
        state = reconcileTreeItems(state, [replacement]);

        expect(isTreeItemExpanded(state, replacement)).toBe(false);
        expect(serializeExtensionTreeState(state)).toEqual({
            expandedItemIds: [],
            initializedItemIds: ['stable-branch'],
        });
    });

    it('restores only stable ids and keeps handle-only items transient', () => {
        const stable = item({ handle: 'new-handle', id: 'stable', collapsibleState: 'collapsed' });
        const transient = item({ handle: 'transient', collapsibleState: 'collapsed' });
        let state = createExtensionTreeState({
            expandedItemIds: ['stable'],
            initializedItemIds: ['stable'],
            focusedItemId: 'stable',
        });
        state = reconcileTreeItems(state, [stable, transient]);
        state = toggleTreeItem(state, transient);
        state = focusTreeItem(state, stable);

        expect(isTreeItemExpanded(state, stable)).toBe(true);
        expect(isTreeItemExpanded(state, transient)).toBe(true);
        expect(serializeExtensionTreeState(state)).toEqual({
            expandedItemIds: ['stable'],
            initializedItemIds: ['stable'],
            focusedItemId: 'stable',
        });
    });

    it('retires cached descendants when a refreshed branch reuses a stable child handle', () => {
        const stableChild = item({
            collapsibleState: 'collapsed',
            handle: 'id:stable-child',
            id: 'stable-child',
        });
        const oldGrandchild = item({ handle: 'old-grandchild', id: 'old-grandchild' });
        const current = new Map<string, readonly TreeItemDto[]>([
            ['parent', [stableChild]],
            [stableChild.handle, [oldGrandchild]],
            [oldGrandchild.handle, []],
        ]);
        const refreshedChild = {
            ...stableChild,
            label: 'Refreshed child',
            accessibilityLabel: 'Refreshed child',
        };

        const result = replaceTreeChildren(current, 'parent', [refreshedChild]);

        expect(result.children.get('parent')).toEqual([refreshedChild]);
        expect(result.children.has(stableChild.handle)).toBe(false);
        expect(result.children.has(oldGrandchild.handle)).toBe(false);
        expect(result.retiredHandles).toEqual(new Set([stableChild.handle, oldGrandchild.handle]));
    });

    it('toggles every known collapsible descendant while preserving unrelated branches', () => {
        const root = item({ handle: 'root', id: 'root', collapsibleState: 'collapsed' });
        const nested = item({ handle: 'nested', id: 'nested', collapsibleState: 'collapsed' });
        const deep = item({ handle: 'deep', id: 'deep', collapsibleState: 'collapsed' });
        const unknown = item({ handle: 'unknown', id: 'unknown', collapsibleState: 'collapsed' });
        const leaf = item({ handle: 'leaf', id: 'leaf' });
        const sibling = item({ handle: 'sibling', id: 'sibling', collapsibleState: 'collapsed' });
        const children = new Map<string, readonly TreeItemDto[]>([
            [root.handle, [nested, leaf]],
            [nested.handle, [deep, unknown]],
            [deep.handle, [root]],
        ]);
        let state = toggleTreeItem(createExtensionTreeState(), sibling);

        state = toggleTreeItemSubtree(state, root, children);
        expect(isTreeItemExpanded(state, root)).toBe(true);
        expect(isTreeItemExpanded(state, nested)).toBe(true);
        expect(isTreeItemExpanded(state, deep)).toBe(true);
        expect(isTreeItemExpanded(state, unknown)).toBe(false);
        expect(isTreeItemExpanded(state, sibling)).toBe(true);

        state = toggleTreeItemSubtree(state, root, children);
        expect(isTreeItemExpanded(state, root)).toBe(false);
        expect(isTreeItemExpanded(state, nested)).toBe(false);
        expect(isTreeItemExpanded(state, deep)).toBe(false);
        expect(isTreeItemExpanded(state, sibling)).toBe(true);
        expect(serializeExtensionTreeState(state).initializedItemIds).toEqual(
            expect.arrayContaining(['root', 'nested', 'deep', 'sibling']),
        );
    });

    it('prioritizes the most recently toggled branch at the persistence safety limit', () => {
        const existing = Array.from({ length: MAX_VIEW_TREE_PERSISTED_IDS }, (_, index) =>
            item({ handle: `old-${index}`, id: `old-${index}`, collapsibleState: 'collapsed' }),
        );
        const root = item({ handle: 'root', id: 'root', collapsibleState: 'collapsed' });
        let state = reconcileTreeItems(createExtensionTreeState(), existing);

        state = toggleTreeItemSubtree(state, root, new Map([[root.handle, []]]));

        expect(serializeExtensionTreeState(state).initializedItemIds).toContain('root');
    });
});

describe('extension tree interaction gate', () => {
    const leaf = item({ command: true, handle: 'leaf', id: 'leaf' });
    const branch = item({
        collapsibleState: 'collapsed',
        command: true,
        handle: 'branch',
        id: 'branch',
    });
    const plainBranch = item({
        collapsibleState: 'collapsed',
        handle: 'plain-branch',
        id: 'plain-branch',
    });

    it('executes a leaf exactly once across Chromium click-click-doubleClick dispatch', () => {
        expect(pointerTreeRowAction(leaf, 'body', 'click', 1)).toBe('activate');
        expect(pointerTreeRowAction(leaf, 'body', 'click', 2)).toBe('none');
        expect(pointerTreeRowAction(leaf, 'body', 'doubleClick', 2)).toBe('none');
    });

    it('activates a command branch body exactly once without changing expansion', () => {
        expect(pointerTreeRowAction(branch, 'body', 'click', 1)).toBe('activate');
        expect(pointerTreeRowAction(branch, 'body', 'click', 2)).toBe('none');
        expect(pointerTreeRowAction(branch, 'body', 'doubleClick', 2)).toBe('none');
        expect(pointerTreeRowAction(branch, 'disclosure', 'click', 1)).toBe('toggle');
        expect(pointerTreeRowAction(branch, 'disclosure', 'click', 1, true)).toBe(
            'toggle-recursive',
        );
        expect(pointerTreeRowAction(branch, 'disclosure', 'click', 2)).toBe('none');
    });

    it('gives a command branch body the recursive toggle Option-click promises', () => {
        // Regression: a collapsible row that also opens a page activated the command on Option-click,
        // so recursive disclosure was reachable on its chevron alone.
        expect(pointerTreeRowAction(branch, 'body', 'click', 1, true)).toBe('toggle-recursive');
        expect(pointerTreeRowAction(leaf, 'body', 'click', 1, true)).toBe('activate');
    });

    it('keeps a plain branch body as an expansion target', () => {
        expect(pointerTreeRowAction(plainBranch, 'body', 'click', 1)).toBe('toggle');
        expect(pointerTreeRowAction(plainBranch, 'body', 'click', 2)).toBe('none');
        expect(pointerTreeRowAction(plainBranch, 'body', 'doubleClick', 2)).toBe('none');
        expect(pointerTreeRowAction(plainBranch, 'disclosure', 'click', 1)).toBe('toggle');
        expect(pointerTreeRowAction(plainBranch, 'body', 'click', 1, true)).toBe(
            'toggle-recursive',
        );
    });

    it('keeps keyboard activation and expansion as single explicit actions', () => {
        expect(keyboardTreeRowAction(leaf, 'Enter')).toBe('activate');
        expect(keyboardTreeRowAction(branch, 'Enter')).toBe('activate');
        expect(keyboardTreeRowAction(branch, ' ')).toBe('toggle');
        expect(keyboardTreeRowAction(leaf, ' ')).toBe('none');
    });
});

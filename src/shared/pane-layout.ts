import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from './ipc/layout';
import type {
    PaneLayout,
    PaneLayoutNode,
    PaneNode,
    PaneResource,
    PaneSplitNode,
    PaneTab,
} from './ipc/pane-layout';
import { isRepeatablePaneResource, paneResourceKey } from './ipc/pane-layout';

export type PaneIdFactory = () => string;

const createId: PaneIdFactory = () => crypto.randomUUID();

/**
 * The single reducer behind every Workbench layout mutation. It never inspects a tab's kind: a Terminal, a file, a
 * diff, and a transcript reorder, move, split, and close through exactly the same code. The one resource-dependent rule
 * lives in `isRepeatablePaneResource` and only decides whether opening a resource that is already somewhere in the tree
 * creates a second occurrence or reveals the existing one.
 */

export function createPaneLayout(
    resource?: PaneResource,
    id: PaneIdFactory = createId,
): PaneLayout {
    const tabs = resource ? [{ id: id(), resource }] : [];
    const root: PaneNode = {
        type: 'pane',
        id: id(),
        tabs,
        activeTabId: tabs[0]?.id,
    };
    return { root, activePaneId: root.id };
}

export function listPanes(layout: PaneLayout): PaneNode[] {
    const panes: PaneNode[] = [];
    const visit = (node: PaneLayoutNode): void => {
        if (node.type === 'pane') {
            panes.push(node);
            return;
        }
        visit(node.first);
        visit(node.second);
    };
    visit(layout.root);
    return panes;
}

export function findPane(layout: PaneLayout, paneId: string): PaneNode | undefined {
    return listPanes(layout).find((pane) => pane.id === paneId);
}

/**
 * The pane a tab occurrence lives in, together with the occurrence itself.
 */
export function findTab(
    layout: PaneLayout,
    tabId: string,
): { pane: PaneNode; tab: PaneTab } | undefined {
    for (const pane of listPanes(layout)) {
        const tab = pane.tabs.find((candidate) => candidate.id === tabId);
        if (tab) return { pane, tab };
    }
    return undefined;
}

/**
 * Every occurrence of one resource, in tree order. A Terminal has at most one; a document may have several.
 */
export function findResourceTabs(
    layout: PaneLayout,
    resource: PaneResource,
): Array<{ pane: PaneNode; tab: PaneTab }> {
    const key = paneResourceKey(resource);
    return listPanes(layout).flatMap((pane) =>
        pane.tabs
            .filter((tab) => paneResourceKey(tab.resource) === key)
            .map((tab) => ({ pane, tab })),
    );
}

export function activePane(layout: PaneLayout): PaneNode {
    const panes = listPanes(layout);
    return panes.find((pane) => pane.id === layout.activePaneId) ?? panes[0];
}

export function activeTab(layout: PaneLayout): PaneTab | undefined {
    const pane = activePane(layout);
    return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
}

function replaceNode(
    node: PaneLayoutNode,
    nodeId: string,
    replacement: (node: PaneLayoutNode) => PaneLayoutNode,
): PaneLayoutNode {
    if (node.id === nodeId) return replacement(node);
    if (node.type === 'pane') return node;
    const first = replaceNode(node.first, nodeId, replacement);
    const second = replaceNode(node.second, nodeId, replacement);
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

/**
 * Drops a tab and, when that empties a pane, the pane itself — its sibling takes the whole split. The last remaining
 * pane always survives as the empty Workbench so every command still has somewhere to open into.
 */
function removeTabFromNode(node: PaneLayoutNode, tabId: string): PaneLayoutNode | undefined {
    if (node.type === 'pane') {
        if (node.tabs.every((tab) => tab.id !== tabId)) return node;
        const index = node.tabs.findIndex((tab) => tab.id === tabId);
        const tabs = node.tabs.filter((tab) => tab.id !== tabId);
        if (tabs.length === 0) return undefined;
        // VS Code activates the tab that slid into the closed one's place, falling back to its left neighbour.
        const successor = tabs[Math.min(index, tabs.length - 1)];
        return {
            ...node,
            tabs,
            activeTabId: node.activeTabId === tabId ? successor.id : node.activeTabId,
        };
    }
    const first = removeTabFromNode(node.first, tabId);
    const second = removeTabFromNode(node.second, tabId);
    if (!first) return second;
    if (!second) return first;
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

/**
 * Keeps `activePaneId` pointing at a pane that still exists, so the fallback target of every command stays valid after
 * a pane collapses.
 */
function withValidActivePane(layout: PaneLayout): PaneLayout {
    const panes = listPanes(layout);
    if (layout.activePaneId && panes.some((pane) => pane.id === layout.activePaneId)) return layout;
    return { ...layout, activePaneId: panes[0]?.id };
}

export function selectTab(layout: PaneLayout, tabId: string): PaneLayout {
    const found = findTab(layout, tabId);
    if (!found) return layout;
    return {
        root: replaceNode(layout.root, found.pane.id, (node) => ({
            ...(node as PaneNode),
            activeTabId: tabId,
        })),
        activePaneId: found.pane.id,
    };
}

interface OpenResourceOptions {
    /**
     * Where to open; defaults to the active pane.
     */
    paneId?: string;
    /**
     * Force a new occurrence even though the resource is already open in the target pane. Only repeatable resources
     * honor it — a Terminal has one PTY and therefore one tab.
     */
    duplicate?: boolean;
    preview?: boolean;
}

export function openResource(
    layout: PaneLayout,
    resource: PaneResource,
    { paneId, duplicate = false, preview }: OpenResourceOptions = {},
    id: PaneIdFactory = createId,
): PaneLayout {
    const target = (paneId ? findPane(layout, paneId) : undefined) ?? activePane(layout);
    const existing = findResourceTabs(layout, resource);
    const inTargetPane = existing.find((occurrence) => occurrence.pane.id === target.id);
    if (inTargetPane && !duplicate) return selectTab(layout, inTargetPane.tab.id);
    // A Terminal is an instance: opening one that already lives elsewhere reveals it instead of cloning the PTY.
    if (existing.length > 0 && !isRepeatablePaneResource(resource))
        return selectTab(layout, existing[0].tab.id);
    const tab: PaneTab = { id: id(), resource, ...(preview && { preview: true }) };
    return {
        root: replaceNode(layout.root, target.id, (node) => {
            const pane = node as PaneNode;
            // A preview tab is a slot, not a stack: the next preview replaces it rather than piling up.
            const tabs = preview
                ? [...pane.tabs.filter((candidate) => !candidate.preview), tab]
                : [...pane.tabs, tab];
            return { ...pane, tabs, activeTabId: tab.id };
        }),
        activePaneId: target.id,
    };
}

export function closeTab(layout: PaneLayout, tabId: string): PaneLayout {
    if (!findTab(layout, tabId)) return layout;
    const root = removeTabFromNode(layout.root, tabId);
    return withValidActivePane({
        ...layout,
        // The Workbench keeps one pane even when its last tab closes.
        root: root ?? { type: 'pane', id: layout.root.id, tabs: [] },
    });
}

/**
 * Moves an occurrence into `targetPaneId`, optionally at a specific index. Every resource moves the same way; nothing
 * is ever duplicated by a move, which is what makes drag and drop kind-agnostic.
 */
export function moveTab(
    layout: PaneLayout,
    tabId: string,
    targetPaneId: string,
    targetIndex?: number,
): PaneLayout {
    const found = findTab(layout, tabId);
    if (!found || !findPane(layout, targetPaneId)) return layout;
    const withoutTab =
        found.pane.id === targetPaneId
            ? layout
            : { ...layout, root: removeTabFromNode(layout.root, tabId) ?? layout.root };
    const insert = (pane: PaneNode): PaneNode => {
        const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
        const index =
            targetIndex === undefined
                ? tabs.length
                : Math.max(0, Math.min(targetIndex, tabs.length));
        tabs.splice(index, 0, found.tab);
        return { ...pane, tabs, activeTabId: tabId };
    };
    const target = findPane(withoutTab, targetPaneId);
    if (!target) return layout;
    return withValidActivePane({
        root: replaceNode(withoutTab.root, targetPaneId, (node) => insert(node as PaneNode)),
        activePaneId: targetPaneId,
    });
}

/**
 * Splits `targetPaneId` and moves the occurrence into the new pane. Dropping a tab on a pane edge is this operation for
 * every kind; `openResource` with `duplicate` is how a document instead gains a second occurrence.
 */
export function splitTabIntoPane(
    layout: PaneLayout,
    tabId: string,
    targetPaneId: string,
    direction: PaneSplitNode['direction'],
    id: PaneIdFactory = createId,
): PaneLayout {
    const found = findTab(layout, tabId);
    const target = findPane(layout, targetPaneId);
    if (!found || !target) return layout;
    // Splitting a pane's only tab off itself would just move the pane sideways.
    if (found.pane.id === targetPaneId && found.pane.tabs.length === 1) return layout;
    const removed = removeTabFromNode(layout.root, tabId) ?? layout.root;
    if (listPanes({ root: removed }).every((pane) => pane.id !== targetPaneId)) return layout;
    const pane: PaneNode = { type: 'pane', id: id(), tabs: [found.tab], activeTabId: found.tab.id };
    return {
        root: replaceNode(removed, targetPaneId, (node) => ({
            type: 'split',
            id: id(),
            direction,
            ratio: 0.5,
            first: node,
            second: pane,
        })),
        activePaneId: pane.id,
    };
}

export function resizeSplit(layout: PaneLayout, splitId: string, ratio: number): PaneLayout {
    const boundedRatio = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
    return {
        ...layout,
        root: replaceNode(layout.root, splitId, (node) =>
            node.type === 'split' ? { ...node, ratio: boundedRatio } : node,
        ),
    };
}

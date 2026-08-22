import type {
    PaneLayout,
    PaneLayoutNode,
    PaneNode,
    PaneResource,
    PaneSplitNode,
    PaneTab,
} from './ipc/pane-layout';
import {
    isRepeatablePaneResource,
    MAX_PANE_LAYOUT_PANES,
    MAX_SPLIT_RATIO,
    MAX_TABS_PER_PANE,
    MIN_SPLIT_RATIO,
    paneResourceKey,
} from './ipc/pane-layout';

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
 * Every tab occurrence in the tree, each with the pane that holds it, in tree order.
 */
export function listPaneTabs(layout: PaneLayout): PaneTabOccurrence[] {
    return listPanes(layout).flatMap((pane) => pane.tabs.map((tab) => ({ pane, tab })));
}

export interface PaneTabOccurrence {
    pane: PaneNode;
    tab: PaneTab;
}

/**
 * The pane a tab occurrence lives in, together with the occurrence itself.
 */
export function findTab(layout: PaneLayout, tabId: string): PaneTabOccurrence | undefined {
    return listPaneTabs(layout).find((occurrence) => occurrence.tab.id === tabId);
}

/**
 * Every occurrence of one resource, in tree order. A Terminal has at most one; a document may have several.
 */
export function findResourceTabs(layout: PaneLayout, resource: PaneResource): PaneTabOccurrence[] {
    const key = paneResourceKey(resource);
    return listPaneTabs(layout).filter(
        (occurrence) => paneResourceKey(occurrence.tab.resource) === key,
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
    /**
     * A preview tab is a slot, not a stack: the next preview takes over the existing one in place — same position, same
     * tab id. Reusing the id is what keeps the slot's DOM node, focus, and enter/exit animation identity stable, so
     * previewing file after file swaps a label instead of destroying and recreating a tab each time.
     */
    const replaced = preview ? target.tabs.find((candidate) => candidate.preview) : undefined;
    if (!replaced && target.tabs.length >= MAX_TABS_PER_PANE) return layout;
    const tab: PaneTab = { id: replaced?.id ?? id(), resource, ...(preview && { preview: true }) };
    return {
        root: replaceNode(layout.root, target.id, (node) => {
            const pane = node as PaneNode;
            const tabs = replaced
                ? pane.tabs.map((candidate) => (candidate.id === replaced.id ? tab : candidate))
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
 * Which side of the target pane the new pane takes. The four drop edges, the four split commands, and the tab context
 * menu all speak this vocabulary, so the split axis and the ordering are decided in one place instead of at every call
 * site.
 */
export type PaneSplitSide = 'down' | 'left' | 'right' | 'up';

const splitDirections: Record<PaneSplitSide, PaneSplitNode['direction']> = {
    left: 'horizontal',
    right: 'horizontal',
    up: 'vertical',
    down: 'vertical',
};

/**
 * Why splitting `tabId` into `targetPaneId` would change nothing, or `undefined` when it would take effect.
 *
 * `splitTabIntoPane` returns the identical layout in both blocked cases, which a menu cannot tell apart from a
 * successful edit. A caller that offers Split as a command has to ask first, or it renders an enabled item that looks
 * broken when clicked instead of one that explains why it is unavailable.
 */
export function paneSplitBlockedReason(
    layout: PaneLayout,
    tabId: string,
    targetPaneId: string,
): 'missing' | 'only-tab' | 'pane-limit' | undefined {
    const found = findTab(layout, tabId);
    if (!found || !findPane(layout, targetPaneId)) return 'missing';
    // Splitting a pane's only tab off itself would just move the pane sideways.
    if (found.pane.id === targetPaneId && found.pane.tabs.length === 1) return 'only-tab';
    if (listPanes(layout).length >= MAX_PANE_LAYOUT_PANES) return 'pane-limit';
    return undefined;
}

/**
 * Splits `targetPaneId` and moves the occurrence into the new pane. Dropping a tab on a pane edge is this operation for
 * every kind; `openResource` with `duplicate` is how a document instead gains a second occurrence.
 */
export function splitTabIntoPane(
    layout: PaneLayout,
    tabId: string,
    targetPaneId: string,
    side: PaneSplitSide,
    id: PaneIdFactory = createId,
): PaneLayout {
    if (paneSplitBlockedReason(layout, tabId, targetPaneId)) return layout;
    const found = findTab(layout, tabId);
    if (!found) return layout;
    const removed = removeTabFromNode(layout.root, tabId) ?? layout.root;
    if (listPanes({ root: removed }).every((pane) => pane.id !== targetPaneId)) return layout;
    const pane: PaneNode = { type: 'pane', id: id(), tabs: [found.tab], activeTabId: found.tab.id };
    const isBefore = side === 'left' || side === 'up';
    return {
        root: replaceNode(removed, targetPaneId, (node) => ({
            type: 'split',
            id: id(),
            direction: splitDirections[side],
            ratio: 0.5,
            first: isBefore ? pane : node,
            second: isBefore ? node : pane,
        })),
        activePaneId: pane.id,
    };
}

/**
 * Adds a Terminal tab without disturbing what is currently focused. `openResource` always activates what it opens,
 * which is right for a user-initiated action but wrong for retrofitting a newly created Terminal into a Workbench Root
 * that is not the one on screen: stealing activation away from whatever that Root's owner last arranged there would be
 * a worse regression than a tab that simply exists, unselected, until they switch to it.
 *
 * A no-op when the Terminal already has an occurrence: the caller cannot tell whether this Root is the one the normal
 * `openResource` flow is about to place the Terminal into, so silently re-adding an already-present Terminal would
 * double its tab instead of leaving it alone.
 */
export function addPaneTerminalSilently(
    layout: PaneLayout,
    terminalId: string,
    id: PaneIdFactory = createId,
): PaneLayout {
    if (findResourceTabs(layout, { kind: 'terminal', terminalId }).length > 0) return layout;
    const target = activePane(layout);
    if (target.tabs.length >= MAX_TABS_PER_PANE) return layout;
    const tab: PaneTab = { id: id(), resource: { kind: 'terminal', terminalId } };
    return {
        ...layout,
        root: replaceNode(layout.root, target.id, (node) => ({
            ...(node as PaneNode),
            tabs: [...(node as PaneNode).tabs, tab],
        })),
    };
}

/**
 * Every Terminal placed in this layout, in tree order. A Terminal occupies exactly one pane, so this is also the set of
 * Terminals the Workbench currently shows.
 */
export function listPaneTerminalIds(layout: PaneLayout): string[] {
    return listPanes(layout).flatMap((pane) =>
        pane.tabs.flatMap((tab) =>
            tab.resource.kind === 'terminal' ? [tab.resource.terminalId] : [],
        ),
    );
}

/**
 * The Terminals actually on screen: one per pane, since a pane shows only its active tab. Restore and attachment work
 * prioritizes these over Terminals sitting behind another tab.
 */
export function visiblePaneTerminalIds(layout: PaneLayout): string[] {
    return listPanes(layout).flatMap((pane) => {
        const visible = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs.at(0);
        return visible?.resource.kind === 'terminal' ? [visible.resource.terminalId] : [];
    });
}

/**
 * Drops a closed Terminal's occurrence. Called when the process is gone, so nothing else in the tree has to know.
 */
export function removePaneTerminal(layout: PaneLayout, terminalId: string): PaneLayout {
    const occurrence = findResourceTabs(layout, { kind: 'terminal', terminalId }).at(0);
    return occurrence ? closeTab(layout, occurrence.tab.id) : layout;
}

/**
 * Turns a preview occurrence into an ordinary one. Pinning is per occurrence: previewing the same file in two panes and
 * pinning one leaves the other replaceable.
 */
export function pinPaneTab(layout: PaneLayout, tabId: string): PaneLayout {
    const found = findTab(layout, tabId);
    if (!found?.tab.preview) return layout;
    return {
        ...layout,
        root: replaceNode(layout.root, found.pane.id, (node) => ({
            ...(node as PaneNode),
            tabs: (node as PaneNode).tabs.map((tab) =>
                tab.id === tabId ? { id: tab.id, resource: tab.resource } : tab,
            ),
        })),
    };
}

export type PaneTabCloseMode = 'all' | 'one' | 'others' | 'right';

/**
 * Close Others / Close to the Right / Close All are pane-local, matching VS Code: they act on the bar the tab lives in,
 * never on occurrences in other panes.
 */
export function paneTabIdsToClose(
    layout: PaneLayout,
    tabId: string,
    mode: PaneTabCloseMode,
): string[] {
    const found = findTab(layout, tabId);
    if (!found) return [];
    const { tabs } = found.pane;
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (mode === 'one') return [tabId];
    if (mode === 'all') return tabs.map((tab) => tab.id);
    if (mode === 'others') return tabs.flatMap((tab) => (tab.id === tabId ? [] : [tab.id]));
    return tabs.slice(index + 1).map((tab) => tab.id);
}

export function closeTabs(layout: PaneLayout, tabIds: readonly string[]): PaneLayout {
    return tabIds.reduce((current, tabId) => closeTab(current, tabId), layout);
}

/**
 * Rewrites document paths after a Project root move. Terminal occurrences carry no path and are left untouched.
 *
 * A Replace can remap two occurrences in the same pane onto the same target path — the moved file and a file already
 * open at the destination. The schema forbids a pane from listing one resource twice, so occurrences are merged
 * deterministically: the earliest tab in tree order survives, later ones are dropped, and a dropped active tab hands
 * activation to its survivor.
 */
export function remapPaneLayoutPaths(
    layout: PaneLayout,
    remap: (path: string) => string,
): PaneLayout {
    const remapResource = (resource: PaneResource): PaneResource => {
        if (resource.kind !== 'file') return resource;
        const path = remap(resource.path);
        return path === resource.path ? resource : { kind: 'file', path };
    };
    const visit = (node: PaneLayoutNode): PaneLayoutNode => {
        if (node.type === 'split') {
            const first = visit(node.first);
            const second = visit(node.second);
            return first === node.first && second === node.second
                ? node
                : { ...node, first, second };
        }
        const remapped = node.tabs.map((tab) => {
            const resource = remapResource(tab.resource);
            return resource === tab.resource ? tab : { ...tab, resource };
        });
        if (remapped.every((tab, index) => tab === node.tabs[index])) return node;
        const survivorIdByKey = new Map<string, string>();
        for (const tab of remapped) {
            const key = paneResourceKey(tab.resource);
            if (!survivorIdByKey.has(key)) survivorIdByKey.set(key, tab.id);
        }
        const tabs = remapped.filter(
            (tab) => survivorIdByKey.get(paneResourceKey(tab.resource)) === tab.id,
        );
        const activeSourceTab = remapped.find((tab) => tab.id === node.activeTabId);
        const activeTabId = activeSourceTab
            ? survivorIdByKey.get(paneResourceKey(activeSourceTab.resource))
            : node.activeTabId;
        return { ...node, tabs, activeTabId };
    };
    const root = visit(layout.root);
    return root === layout.root ? layout : { ...layout, root };
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

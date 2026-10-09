import type { PaneLayoutNode, PaneNode, PaneTab, SessionState } from '@caxri/protocol';
import {
    activePane,
    closeTabs,
    isExternalEditorTabPath,
    listPanes,
    listPaneTabs,
    MAX_TABS_PER_PANE,
    paneResourceKey,
    parseFilePreviewTab,
} from '@caxri/protocol';

interface ExternalTabPlacement {
    active: boolean;
    index: number;
    paneId: string;
    tab: PaneTab;
}

interface ExternalSessionState {
    activePaneId?: string;
    placements: ExternalTabPlacement[];
}

const externalStates = new Map<string, ExternalSessionState>();

/**
 * An external document's own tab, or a preview of one: both name a Renderer-only buffer that cannot be restored.
 */
function isExternalTab(tab: PaneTab): boolean {
    if (tab.resource.kind !== 'file') return false;
    const { path } = tab.resource;
    return isExternalEditorTabPath(parseFilePreviewTab(path)?.path ?? path);
}

function hasPaneLayoutRoot(state: SessionState): boolean {
    return Boolean((state as { paneLayout?: { root?: unknown } }).paneLayout?.root);
}

function stateKey(state: Pick<SessionState, 'sessionId' | 'workbenchProjectId'>): string {
    return `${state.sessionId}\0${state.workbenchProjectId}`;
}

function replacePane(node: PaneLayoutNode, paneId: string, replacement: PaneNode): PaneLayoutNode {
    if (node.type === 'pane') return node.id === paneId ? replacement : node;
    const first = replacePane(node.first, paneId, replacement);
    const second = replacePane(node.second, paneId, replacement);
    return first === node.first && second === node.second ? node : { ...node, first, second };
}

/**
 * Captures only external tab occurrences. The real path and content live in the document cache, while this placement
 * overlay lets an in-process bootstrap refresh keep the tabs without ever submitting them to Session persistence.
 */
export function recordExternalEditorState(state: SessionState): void {
    if (!hasPaneLayoutRoot(state)) return;
    const placements = listPaneTabs(state.paneLayout).flatMap(({ pane, tab }) =>
        isExternalTab(tab)
            ? [
                  {
                      active: pane.activeTabId === tab.id,
                      index: pane.tabs.findIndex((candidate) => candidate.id === tab.id),
                      paneId: pane.id,
                      tab,
                  },
              ]
            : [],
    );
    const key = stateKey(state);
    if (placements.length === 0) {
        externalStates.delete(key);
        return;
    }
    externalStates.set(key, { activePaneId: state.paneLayout.activePaneId, placements });
}

/**
 * Removes Renderer-only resources at the one boundary that submits Session state to the Runtime.
 */
export function stripExternalEditorTabs(state: SessionState): SessionState {
    if (!hasPaneLayoutRoot(state)) return state;
    const tabIds = listPaneTabs(state.paneLayout).flatMap(({ tab }) =>
        isExternalTab(tab) ? [tab.id] : [],
    );
    if (tabIds.length === 0) return state;
    const stripped = closeTabs(state.paneLayout, tabIds);
    const omitUndefinedActiveTab = (node: PaneLayoutNode): PaneLayoutNode => {
        if (node.type === 'split') {
            const first = omitUndefinedActiveTab(node.first);
            const second = omitUndefinedActiveTab(node.second);
            return first === node.first && second === node.second
                ? node
                : { ...node, first, second };
        }
        if (node.activeTabId !== undefined) return node;
        return { type: 'pane', id: node.id, tabs: node.tabs };
    };
    return {
        ...state,
        paneLayout: { ...stripped, root: omitUndefinedActiveTab(stripped.root) },
    };
}

/**
 * Reapplies an in-memory external-tab overlay to an authoritative durable Session snapshot.
 */
export function mergeExternalEditorTabs(state: SessionState): SessionState {
    if (!hasPaneLayoutRoot(state)) return state;
    const external = externalStates.get(stateKey(state));
    if (!external) return state;
    let layout = state.paneLayout;
    for (const placement of external.placements) {
        if (listPaneTabs(layout).some(({ tab }) => tab.id === placement.tab.id)) continue;
        const target =
            listPanes(layout).find((pane) => pane.id === placement.paneId) ?? activePane(layout);
        if (
            target.tabs.length >= MAX_TABS_PER_PANE ||
            target.tabs.some(
                (tab) => paneResourceKey(tab.resource) === paneResourceKey(placement.tab.resource),
            )
        )
            continue;
        const tabs = [...target.tabs];
        tabs.splice(Math.min(placement.index, tabs.length), 0, placement.tab);
        const nextPane = {
            ...target,
            tabs,
            activeTabId: placement.active ? placement.tab.id : target.activeTabId,
        };
        layout = { ...layout, root: replacePane(layout.root, target.id, nextPane) };
    }
    const activePaneId = external.activePaneId;
    if (activePaneId && listPanes(layout).some((pane) => pane.id === activePaneId))
        layout = { ...layout, activePaneId };
    return layout === state.paneLayout ? state : { ...state, paneLayout: layout };
}

export function dropExternalEditorSessions(sessionIds: readonly string[]): void {
    const removed = new Set(sessionIds);
    for (const key of externalStates.keys())
        if (removed.has(key.split('\0', 1)[0])) externalStates.delete(key);
}

export function resetExternalEditorStateForTests(): void {
    externalStates.clear();
}

import type {
    PaneFocusDirection,
    PaneLayout,
    PaneResource,
    PaneSplitSide,
    PaneTab,
} from '@caxri/protocol';
import {
    activePane,
    activeTab,
    adjacentPaneId,
    findResourceTabs,
    listPanes,
    moveTab,
    resizeSplit,
    selectTab,
    splitTabIntoPane,
} from '@caxri/protocol';

import { getSessionState, useSessionState } from '../../stores/selectors';
import { patchSessionState } from '../../stores/workbench';
import { supersedePendingFileOpens } from '../editor/editor-open-intent';
import { workTabId } from '../tabs/work-tab-accessibility';
import { focusTerminalById } from '../terminal/terminal-commands';

/**
 * The single write path for every Workbench layout mutation. Callers describe the edit with the pure reducer in
 * `@caxri/protocol`'s pane-layout reducer and hand the result here; nothing else may write `sessionState.paneLayout`.
 */
function applyPaneLayout(next: PaneLayout, failureLabel?: string): void {
    const current = getSessionState();
    if (!current || next === current.paneLayout) return;
    patchSessionState({ ...current, paneLayout: next }, failureLabel);
}

export function getPaneLayout(): PaneLayout | undefined {
    return getSessionState()?.paneLayout;
}

/**
 * An explicit selection wins over a file open still awaiting its read; otherwise that open would re-activate the tab
 * the user just left.
 */
export function selectPaneTab(tabId: string): void {
    const layout = getPaneLayout();
    if (!layout) return;
    supersedePendingFileOpens();
    applyPaneLayout(selectTab(layout, tabId));
}

/**
 * Focusing a pane without changing which tab it shows: the fallback target for every command that resolves "where does
 * this happen" from the layout rather than from DOM focus.
 */
export function focusPane(paneId: string): void {
    const layout = getPaneLayout();
    const pane = layout && listPanes(layout).find((candidate) => candidate.id === paneId);
    if (!layout || !pane || layout.activePaneId === paneId) return;
    applyPaneLayout({ ...layout, activePaneId: paneId });
}

export function movePaneTab(tabId: string, targetPaneId: string, targetIndex?: number): void {
    const layout = getPaneLayout();
    if (layout) applyPaneLayout(moveTab(layout, tabId, targetPaneId, targetIndex));
}

export function splitPaneTab(tabId: string, targetPaneId: string, side: PaneSplitSide): void {
    const layout = getPaneLayout();
    if (layout) applyPaneLayout(splitTabIntoPane(layout, tabId, targetPaneId, side));
}

export function resizePaneSplit(splitId: string, ratio: number): void {
    const layout = getPaneLayout();
    if (layout) applyPaneLayout(resizeSplit(layout, splitId, ratio));
}

/**
 * The tab a command acts on when nothing names one: the active pane's visible tab.
 */
export function getActivePaneTab(): PaneTab | undefined {
    const layout = getPaneLayout();
    return layout ? activeTab(layout) : undefined;
}

/**
 * Reactive counterpart of {@link getActivePaneTab}, for surfaces that follow the focused tab (Status Bar, Git panel).
 */
export function useActivePaneTab(): PaneTab | undefined {
    const layout = useSessionState()?.paneLayout;
    return layout ? activeTab(layout) : undefined;
}

export function getActivePaneId(): string | undefined {
    const layout = getPaneLayout();
    return layout ? activePane(layout).id : undefined;
}

export function findPaneTabId(resource: PaneResource): string | undefined {
    const layout = getPaneLayout();
    return layout ? findResourceTabs(layout, resource)[0]?.tab.id : undefined;
}

/**
 * Whether {@link focusPaneInDirection} would move focus anywhere for `direction`: the `when` gate behind
 * `workbench.focusPaneLeft/Right/Up/Down`, so the command palette and native menu never offer a move that would
 * silently no-op at a single pane or the edge of the Workbench.
 */
export function canFocusPaneInDirection(direction: PaneFocusDirection): boolean {
    const layout = getPaneLayout();
    if (!layout) return false;
    return adjacentPaneId(layout, activePane(layout).id, direction) !== undefined;
}

/**
 * Moves keyboard focus and `activePaneId` to the pane geometrically adjacent to the active one, then hands focus to
 * that pane's own active tab content: a Terminal reclaims xterm focus, a document reclaims its tab (mirroring
 * `useTabFocusRecovery`'s DOM lookup, the existing pattern for restoring focus to a tab after a layout edit takes it
 * away). A single pane, or `direction` pointing off the edge of the Workbench, leaves focus untouched.
 */
export function focusPaneInDirection(direction: PaneFocusDirection): void {
    const layout = getPaneLayout();
    if (!layout) return;
    const targetId = adjacentPaneId(layout, activePane(layout).id, direction);
    if (!targetId) return;
    focusPane(targetId);
    const target = listPanes(layout).find((pane) => pane.id === targetId);
    const tab =
        target?.tabs.find((candidate) => candidate.id === target.activeTabId) ?? target?.tabs.at(0);
    if (!tab) return;
    if (tab.resource.kind === 'terminal') {
        focusTerminalById(tab.resource.terminalId);
        return;
    }
    document.querySelector<HTMLElement>(`#${CSS.escape(workTabId(tab.id))}`)?.focus();
}

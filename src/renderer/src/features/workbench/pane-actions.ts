import type { PaneSplitSide } from '@shared/pane-layout';
import {
    activePane,
    activeTab,
    findResourceTabs,
    listPanes,
    moveTab,
    paneTabIdsToClose,
    resizeSplit,
    selectTab,
    splitTabIntoPane,
} from '@shared/pane-layout';
import type { PaneLayout, PaneResource, PaneTab } from '@shared/types';

import { getSessionState, useSessionState } from '../../stores/selectors';
import { patchSessionState } from '../../stores/workbench';

/**
 * The single write path for every Workbench layout mutation. Callers describe the edit with the pure reducer in
 * `@shared/pane-layout` and hand the result here; nothing else may write `sessionState.paneLayout`.
 */
function applyPaneLayout(next: PaneLayout, failureLabel?: string): void {
    const current = getSessionState();
    if (!current || next === current.paneLayout) return;
    patchSessionState({ ...current, paneLayout: next }, failureLabel);
}

export function getPaneLayout(): PaneLayout | undefined {
    return getSessionState()?.paneLayout;
}

export function selectPaneTab(tabId: string): void {
    const layout = getPaneLayout();
    if (layout) applyPaneLayout(selectTab(layout, tabId));
}

/**
 * Focusing a pane without changing which tab it shows — the fallback target for every command that resolves "where does
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

export function paneTabCloseFamily(
    tabId: string,
    mode: Parameters<typeof paneTabIdsToClose>[2],
): string[] {
    const layout = getPaneLayout();
    return layout ? paneTabIdsToClose(layout, tabId, mode) : [];
}

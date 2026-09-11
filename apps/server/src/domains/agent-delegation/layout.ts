import type { PaneLayout } from '@caxri/protocol';
import {
    activePane,
    CaxriError,
    findResourceTabs,
    listPanes,
    MAX_PANE_LAYOUT_PANES,
    selectTab,
    splitTabIntoPane,
} from '@caxri/protocol';

/**
 * Rejects a missing caller or full pane tree before a durable child Terminal can be inserted.
 */
export function assertDelegationLayout(layout: PaneLayout, callerTerminalId?: string): void {
    if (listPanes(layout).length >= MAX_PANE_LAYOUT_PANES)
        throw new CaxriError('CAPACITY', 'No space for another visible Agent pane');
    if (
        callerTerminalId &&
        findResourceTabs(layout, { kind: 'terminal', terminalId: callerTerminalId }).length === 0
    )
        throw new CaxriError('CONFLICT', 'Delegation caller pane is unavailable');
}

/**
 * Uses the existing split reducer but restores focus to the caller, following Herdr's sibling-pane flow.
 */
export function delegationLayout(
    layout: PaneLayout,
    childTerminalId: string,
    callerTerminalId?: string,
    size?: { cols: number; rows: number },
): PaneLayout {
    const target = callerTerminalId
        ? findResourceTabs(layout, { kind: 'terminal', terminalId: callerTerminalId }).at(0)?.pane
        : activePane(layout);
    const child = findResourceTabs(layout, { kind: 'terminal', terminalId: childTerminalId }).at(0);
    if (!target || !child) throw new CaxriError('CONFLICT', 'Delegation pane is unavailable');
    /**
     * An external caller has no caller pane; its first task fills the dedicated Session's empty pane.
     */
    if (!callerTerminalId && target.id === child.pane.id && target.tabs.length === 1)
        return selectTab(layout, child.tab.id);
    // Terminal cells are roughly twice as tall as they are wide. Prefer rows for a narrow/tall caller.
    const side = size && (size.cols < 120 || size.cols < size.rows * 2) ? 'down' : 'right';
    const next = splitTabIntoPane(layout, child.tab.id, target.id, side);
    if (next === layout)
        throw new CaxriError('CAPACITY', 'No space for another visible Agent pane');
    return { ...next, activePaneId: layout.activePaneId };
}

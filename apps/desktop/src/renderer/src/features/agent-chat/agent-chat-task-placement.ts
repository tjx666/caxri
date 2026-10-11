import type { PaneLayout } from '@caxri/protocol';
import {
    adjacentPaneId,
    findPane,
    findResourceTabs,
    isAgentTaskTabPath,
    isAgentTurnReviewTabPath,
} from '@caxri/protocol';

/**
 * Where opening a task tab or a turn review tab lands, decided from the layout alone:
 *
 * - `select`: the tab is already open somewhere; focus it rather than opening a duplicate.
 * - `open`: open it in `paneId`, the side pane a previous task or review tab already created to the right of the Chat, so
 *   a run of them collects in one side pane instead of splitting the Workbench again for each.
 * - `split`: open it in the Chat's pane and split it off to the right, as the Codex app opens a subagent beside the
 *   conversation.
 * - `active`: the Chat is not in this layout (it cannot be clicked then, but a stale caller may still ask); open it in
 *   the active pane like any other tab.
 */
export type AgentChatTaskTabPlacement =
    | { kind: 'select'; tabId: string }
    | { kind: 'open'; paneId: string }
    | { kind: 'split'; chatPaneId: string }
    | { kind: 'active' };

export function planAgentChatTaskTabPlacement(
    layout: PaneLayout,
    terminalId: string,
    tabPath: string,
): AgentChatTaskTabPlacement {
    const existing = findResourceTabs(layout, { kind: 'file', path: tabPath }).at(0);
    if (existing) return { kind: 'select', tabId: existing.tab.id };
    const chatPane = findResourceTabs(layout, { kind: 'terminal', terminalId }).at(0)?.pane;
    if (!chatPane) return { kind: 'active' };
    const sideId = adjacentPaneId(layout, chatPane.id, 'right');
    const side = sideId ? findPane(layout, sideId) : undefined;
    const isTaskPane = side?.tabs.some(
        (tab) =>
            tab.resource.kind === 'file' &&
            (isAgentTaskTabPath(tab.resource.path) || isAgentTurnReviewTabPath(tab.resource.path)),
    );
    if (side && isTaskPane) return { kind: 'open', paneId: side.id };
    return { kind: 'split', chatPaneId: chatPane.id };
}

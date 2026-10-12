import { agentContextTabPath, agentTaskTabPath, agentTurnReviewTabPath } from '@caxri/protocol';

import { openEditorTab } from '../editor/document-commands';
import { focusTerminalById } from '../terminal/terminal-pane-handlers';
import {
    findPaneTabId,
    getPaneLayout,
    selectPaneTab,
    splitPaneTab,
} from '../workbench/pane-actions';
import { planAgentChatTaskTabPlacement } from './agent-chat-task-placement';

/**
 * Opens a subagent's or background shell's tab beside its Chat (see {@link planAgentChatTaskTabPlacement}): focused when
 * already open, in the task side pane when one exists, otherwise split off to the right of the Chat. Closing the tab
 * later never stops the task.
 */
export function openAgentChatTaskTab(terminalId: string, taskId: string): void {
    openBesideAgentChat(terminalId, agentTaskTabPath(terminalId, taskId));
}

/**
 * Opens the review of one turn's file changes beside its Chat, where task tabs open.
 */
export function openAgentChatTurnReview(terminalId: string, turnId: string): void {
    openBesideAgentChat(terminalId, agentTurnReviewTabPath(terminalId, turnId));
}

/**
 * Opens a Chat's Context tab beside it, from the context meter's card, so the conversation stays in view.
 */
export function openAgentChatContext(terminalId: string): void {
    openBesideAgentChat(terminalId, agentContextTabPath(terminalId));
}

function openBesideAgentChat(terminalId: string, tabPath: string): void {
    const layout = getPaneLayout();
    if (!layout) return;
    const placement = planAgentChatTaskTabPlacement(layout, terminalId, tabPath);
    switch (placement.kind) {
        case 'select': {
            selectPaneTab(placement.tabId);
            return;
        }
        case 'open': {
            openEditorTab(tabPath, { paneId: placement.paneId });
            return;
        }
        case 'split': {
            // Opened in the Chat's pane first and then split off it, exactly what dragging the tab to the pane's right
            // edge does, so the side pane needs no placement rules of its own.
            openEditorTab(tabPath, { paneId: placement.chatPaneId });
            const tabId = findPaneTabId({ kind: 'file', path: tabPath });
            if (tabId) splitPaneTab(tabId, placement.chatPaneId, 'right');
            return;
        }
        case 'active': {
            openEditorTab(tabPath);
            return;
        }
    }
}

/**
 * Brings a task tab's Chat back into view, for the "no longer available" state's way back.
 */
export function revealAgentChat(terminalId: string): void {
    const tabId = findPaneTabId({ kind: 'terminal', terminalId });
    if (!tabId) return;
    selectPaneTab(tabId);
    focusTerminalById(terminalId);
}

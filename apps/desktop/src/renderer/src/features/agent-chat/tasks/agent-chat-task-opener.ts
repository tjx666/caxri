import {
    agentContextTabPath,
    agentDelegationTabPath,
    agentSideChatTabPath,
    agentTaskTabPath,
    agentTurnReviewTabPath,
    findResourceTabs,
} from '@caxri/protocol';

import { getSelectedSession } from '../../../stores/selectors';
import { openEditorTab } from '../../editor/document-commands';
import { focusTerminalById } from '../../terminal/terminal-pane-handlers';
import {
    findPaneTabId,
    getPaneLayout,
    selectPaneTab,
    splitPaneTab,
} from '../../workbench/pane-actions';
import { runAgentChatComposerCommandWhenReady } from '../composer/agent-chat-composer-commands';
import { usePortalStore } from '../portal/portal-store';
import { planAgentChatTaskTabPlacement } from './agent-chat-task-placement';
import { besideChatTabTerminalId } from './beside-chat-layout';

/**
 * Opens a subagent's or background shell's view beside its Chat (see {@link openBesideAgentChat}). Closing it later
 * never stops the task.
 */
export function openAgentChatTaskTab(terminalId: string, taskId: string): void {
    openBesideAgentChat(agentTaskTabPath(terminalId, taskId));
}

/**
 * Hides a task's view from the selected Session's Portal, the second click of a row's Open button. A view the user
 * moved into the Workbench with "Open in Split" is a pane tab the Portal does not hold, so this leaves it alone.
 */
export function hideAgentChatTaskTab(terminalId: string, taskId: string): void {
    const sessionId = getSelectedSession()?.id;
    if (!sessionId) return;
    usePortalStore.getState().close(sessionId, agentTaskTabPath(terminalId, taskId));
}

/**
 * Opens the review of one turn's file changes beside its Chat, where task tabs open.
 */
export function openAgentChatTurnReview(terminalId: string, turnId: string): void {
    openBesideAgentChat(agentTurnReviewTabPath(terminalId, turnId));
}

/**
 * Opens a Chat's Context tab beside it, from the context meter's card, so the conversation stays in view.
 */
export function openAgentChatContext(terminalId: string): void {
    openBesideAgentChat(agentContextTabPath(terminalId));
}

/**
 * Opens a Chat's side chat beside it, where task tabs open, or focuses it when already open. The main conversation is
 * untouched, so this works mid-turn.
 */
export function openAgentChatSideChat(terminalId: string): void {
    openBesideAgentChat(agentSideChatTabPath(terminalId));
}

/**
 * Opens a consulted child's Chat beside the Chat that asked for it, from the task's record or its Delegated Sessions
 * row, so the user reads and answers it without leaving the conversation.
 */
export function openAgentChatDelegation(childTerminalId: string): void {
    openBesideAgentChat(agentDelegationTabPath(childTerminalId));
}

/**
 * Shows a beside-Chat view: focuses its pane tab when the user already moved it into the Workbench with "Open in
 * Split", otherwise opens it in the selected Session's Portal, the flyout over the window's right edge that takes no
 * Workbench width and never counts as a tab.
 */
function openBesideAgentChat(tabPath: string): void {
    // The Caxri Bot window mounts neither a pane layout nor a Portal, so nothing there could show the view.
    if (!getPaneLayout()) return;
    const tabId = findPaneTabId({ kind: 'file', path: tabPath });
    if (tabId) {
        selectPaneTab(tabId);
        return;
    }
    const sessionId = getSelectedSession()?.id;
    if (!sessionId) return;
    usePortalStore.getState().open(sessionId, tabPath);
}

/**
 * The Portal's "Open in Split": moves its item into the Workbench as a pane tab beside its Chat (see
 * {@link planAgentChatTaskTabPlacement}), for a view the user wants to keep open next to the conversation. The Portal
 * covers the SecondarySidebar, so the split only divides the Chat pane's own width.
 */
export function openPortalItemInSplit(sessionId: string, tabPath: string): void {
    usePortalStore.getState().close(sessionId, tabPath);
    const layout = getPaneLayout();
    const terminalId = besideChatTabTerminalId(tabPath);
    if (!layout || !terminalId) return;
    const chatPaneId = findResourceTabs(layout, { kind: 'terminal', terminalId }).at(0)?.pane.id;
    const slot = chatPaneId
        ? document.querySelector(`[data-pane-slot="${CSS.escape(chatPaneId)}"]`)
        : null;
    const hostWidth = slot?.getBoundingClientRect().width ?? 0;
    const placement = planAgentChatTaskTabPlacement(layout, terminalId, tabPath, hostWidth);
    switch (placement.kind) {
        case 'select': {
            selectPaneTab(placement.tabId);
            return;
        }
        case 'split': {
            // Opened in the Chat's pane first and then split off it, exactly what dragging the tab to the pane's right
            // edge does, so the side pane needs no placement rules of its own.
            openEditorTab(tabPath, { paneId: placement.chatPaneId });
            const tabId = findPaneTabId({ kind: 'file', path: tabPath });
            if (tabId) splitPaneTab(tabId, placement.chatPaneId, 'right', placement.ratio);
            return;
        }
        case 'open':
        case 'tab': {
            openEditorTab(tabPath, { paneId: placement.paneId });
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

/**
 * Brings a Chat forward and sends its message, the turn review's "Back to Chat and Send". The Chat's composer may only
 * mount once its tab is selected, so the send waits for it to register (`runAgentChatComposerCommandWhenReady`).
 */
export function revealAgentChatAndSend(terminalId: string): void {
    revealAgentChat(terminalId);
    runAgentChatComposerCommandWhenReady(terminalId, 'send');
}

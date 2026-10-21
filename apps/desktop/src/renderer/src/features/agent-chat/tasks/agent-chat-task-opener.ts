import type { PaneLayout } from '@caxri/protocol';
import {
    agentContextTabPath,
    agentSideChatTabPath,
    agentTaskTabPath,
    agentTurnReviewTabPath,
    findResourceTabs,
} from '@caxri/protocol';

import { handOffChromeFocus } from '../../../stores/chrome-focus-handoff';
import { PANEL_DIVIDER_WIDTH, useChromeLayoutStore } from '../../../stores/chrome-layout';
import { openEditorTab } from '../../editor/document-commands';
import {
    getSecondarySidebarYieldScope,
    isSecondarySidebarShown,
} from '../../secondary-sidebar/secondary-sidebar-visibility';
import { focusTerminalById } from '../../terminal/terminal-pane-handlers';
import {
    findPaneTabId,
    getPaneLayout,
    selectPaneTab,
    splitPaneTab,
} from '../../workbench/pane-actions';
import { runAgentChatComposerCommandWhenReady } from '../composer/agent-chat-composer-commands';
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

/**
 * Opens a Chat's side chat beside it, where task tabs open, or focuses it when already open. The main conversation is
 * untouched, so this works mid-turn.
 */
export function openAgentChatSideChat(terminalId: string): void {
    openBesideAgentChat(terminalId, agentSideChatTabPath(terminalId));
}

/**
 * Whether the split about to open will make the SecondarySidebar yield: it is on screen and no beside-Chat arrangement
 * holds it open yet. An arrangement that already exists while it is shown means the user revealed it there.
 */
function willSecondarySidebarYield(): boolean {
    return isSecondarySidebarShown() && getSecondarySidebarYieldScope() === undefined;
}

/**
 * The width the Chat's split will have once committed: the Chat pane as laid out now, plus the SecondarySidebar and its
 * divider when they are about to yield to a Chat that fills the Workbench. In a layout the user already split, that
 * width spreads across every pane by their ratios, so it is left out rather than guessed.
 */
function measureBesideChatSplitHost(layout: PaneLayout, chatPaneId: string): number {
    const slot = document.querySelector(`[data-pane-slot="${CSS.escape(chatPaneId)}"]`);
    const width = slot?.getBoundingClientRect().width ?? 0;
    if (layout.root.id !== chatPaneId || !willSecondarySidebarYield()) return width;
    return width + useChromeLayoutStore.getState().secondarySidebarWidth + PANEL_DIVIDER_WIDTH;
}

function openBesideAgentChat(terminalId: string, tabPath: string): void {
    const layout = getPaneLayout();
    if (!layout) return;
    const chatPaneId = findResourceTabs(layout, { kind: 'terminal', terminalId }).at(0)?.pane.id;
    const hostWidth = chatPaneId ? measureBesideChatSplitHost(layout, chatPaneId) : 0;
    const placement = planAgentChatTaskTabPlacement(layout, terminalId, tabPath, hostWidth);
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
            // Before the commit, while the SecondarySidebar that may own focus is still mounted.
            if (willSecondarySidebarYield()) handOffChromeFocus('secondarySidebar', false);
            // Opened in the Chat's pane first and then split off it, exactly what dragging the tab to the pane's right
            // edge does, so the side pane needs no placement rules of its own.
            openEditorTab(tabPath, { paneId: placement.chatPaneId });
            const tabId = findPaneTabId({ kind: 'file', path: tabPath });
            if (tabId) splitPaneTab(tabId, placement.chatPaneId, 'right', placement.ratio);
            return;
        }
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

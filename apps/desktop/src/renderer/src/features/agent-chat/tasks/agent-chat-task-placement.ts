import type { PaneLayout } from '@caxri/protocol';
import { adjacentPaneId, findPane, findResourceTabs } from '@caxri/protocol';

import { besideChatSplitRatio, isBesideChatPane } from './beside-chat-layout';

/**
 * Where opening a tab beside a Chat (task, turn review, side chat, or Context) lands, decided from the layout and the
 * width of the Chat's pane:
 *
 * - `select`: the tab is already open somewhere; focus it rather than opening a duplicate.
 * - `open`: open it in `paneId`, the side pane a previous task or review tab already created to the right of the Chat, so
 *   a run of them collects in one side pane instead of splitting the Workbench again for each.
 * - `split`: open it in the Chat's pane and split it off to the right at `ratio`, as the Codex app opens a subagent
 *   beside the conversation; see {@link besideChatSplitRatio}.
 * - `tab`: the Chat's pane is too narrow for both minimums, so it opens there as an ordinary tab.
 * - `active`: the Chat is not in this layout (it cannot be clicked then, but a stale caller may still ask); open it in
 *   the active pane like any other tab.
 */
export type AgentChatTaskTabPlacement =
    | { kind: 'select'; tabId: string }
    | { kind: 'open'; paneId: string }
    | { kind: 'split'; chatPaneId: string; ratio: number }
    | { kind: 'tab'; paneId: string }
    | { kind: 'active' };

export function planAgentChatTaskTabPlacement(
    layout: PaneLayout,
    terminalId: string,
    tabPath: string,
    /**
     * The width the split will occupy once committed, from `measureBesideChatSplitHost`.
     */
    hostWidth: number,
): AgentChatTaskTabPlacement {
    const existing = findResourceTabs(layout, { kind: 'file', path: tabPath }).at(0);
    if (existing) return { kind: 'select', tabId: existing.tab.id };
    const chatPane = findResourceTabs(layout, { kind: 'terminal', terminalId }).at(0)?.pane;
    if (!chatPane) return { kind: 'active' };
    const sideId = adjacentPaneId(layout, chatPane.id, 'right');
    const side = sideId ? findPane(layout, sideId) : undefined;
    if (side && isBesideChatPane(side)) return { kind: 'open', paneId: side.id };
    const ratio = besideChatSplitRatio(hostWidth);
    if (ratio === undefined) return { kind: 'tab', paneId: chatPane.id };
    return { kind: 'split', chatPaneId: chatPane.id, ratio };
}

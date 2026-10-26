import type { PaneLayout, PaneLayoutNode, PaneNode } from '@caxri/protocol';
import {
    adjacentPaneId,
    findPane,
    listPanes,
    MAX_SPLIT_RATIO,
    MIN_SPLIT_RATIO,
    parseAgentContextTab,
    parseAgentSideChatTab,
    parseAgentTaskTab,
    parseAgentTurnReviewTab,
} from '@caxri/protocol';

/**
 * The narrowest a Chat may get beside its side pane before the side tab opens as an ordinary tab instead: below this
 * the composer toolbar wraps. Same floor LobeHub keeps for its conversation beside a Portal.
 */
const BESIDE_CHAT_MIN_CHAT_WIDTH = 420;
/**
 * The Chat stops growing here and the side pane takes the rest; the transcript's readable column is 768px wide.
 */
const BESIDE_CHAT_MAX_CHAT_WIDTH = 800;
/**
 * The narrowest side pane a split opens with, matching t3code's right panel minimum.
 */
const BESIDE_CHAT_MIN_SIDE_WIDTH = 360;
/**
 * The `basis-1` splitter between the two panes in `pane-view.tsx`.
 */
const PANE_SPLITTER_WIDTH = 4;

/**
 * The Chat Terminal a tab that opens beside its Chat belongs to: a subagent or background shell, a turn's file-change
 * review, the side chat, or the Context breakdown. `undefined` for every other tab.
 */
export function besideChatTabTerminalId(path: string): string | undefined {
    return (
        parseAgentTaskTab(path) ??
        parseAgentTurnReviewTab(path) ??
        parseAgentSideChatTab(path) ??
        parseAgentContextTab(path)
    )?.terminalId;
}

/**
 * Whether a pane already collects tabs opened beside a Chat, so the next one joins it instead of splitting again.
 */
export function isBesideChatPane(pane: PaneNode): boolean {
    return pane.tabs.some(
        (tab) => tab.resource.kind === 'file' && besideChatTabTerminalId(tab.resource.path),
    );
}

/**
 * Whether the layout shows a pane holding only beside-Chat tabs directly right of the Chat they belong to. While it
 * does, the Secondary Sidebar yields its width to the two panes (`secondary-sidebar-visibility.ts`), the way LobeHub's
 * working sidebar steps aside for a Portal. A pane that also holds a file or a Terminal is an ordinary split the user
 * arranged, so it does not count.
 */
export function hasBesideChatArrangement(layout: PaneLayout): boolean {
    return listPanes(layout).some((pane) => {
        if (pane.tabs.length === 0) return false;
        const owners = new Set<string>();
        for (const tab of pane.tabs) {
            const owner =
                tab.resource.kind === 'file'
                    ? besideChatTabTerminalId(tab.resource.path)
                    : undefined;
            if (!owner) return false;
            owners.add(owner);
        }
        const chatPaneId = adjacentPaneId(layout, pane.id, 'left');
        const chatPane = chatPaneId ? findPane(layout, chatPaneId) : undefined;
        return (
            chatPane?.tabs.some(
                (tab) => tab.resource.kind === 'terminal' && owners.has(tab.resource.terminalId),
            ) === true
        );
    });
}

/**
 * The Chat's share of a new split beside it, for a split host `hostWidth` pixels wide. The side pane takes what the
 * Chat does not need past {@link BESIDE_CHAT_MAX_CHAT_WIDTH}, but never less than {@link BESIDE_CHAT_MIN_SIDE_WIDTH}; the
 * old fixed half left a 1024px window with a Chat of about 200px. `undefined` when both minimums cannot fit, so the tab
 * opens as an ordinary tab instead of squeezing either side.
 */
export function besideChatSplitRatio(hostWidth: number): number | undefined {
    const available = hostWidth - PANE_SPLITTER_WIDTH;
    if (
        !Number.isFinite(available) ||
        available < BESIDE_CHAT_MIN_CHAT_WIDTH + BESIDE_CHAT_MIN_SIDE_WIDTH
    )
        return undefined;
    const sideWidth = Math.max(BESIDE_CHAT_MIN_SIDE_WIDTH, available - BESIDE_CHAT_MAX_CHAT_WIDTH);
    const ratio = (available - sideWidth) / available;
    return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/**
 * The fraction of width added to the whole Workbench that reaches pane `paneId`. Each split child grows by `flex: ratio
 * 1 0%` (`pane-view.tsx`), so a horizontal split hands its first child `ratio` of any extra width and its second child
 * the rest, while a vertical split passes all of it to both children. The share is the product of those fractions down
 * the path; `0` when the pane is not in the layout.
 */
export function workbenchWidthShare(layout: PaneLayout, paneId: string): number {
    return widthShareWithin(layout.root, paneId) ?? 0;
}

function widthShareWithin(node: PaneLayoutNode, paneId: string): number | undefined {
    if (node.type === 'pane') return node.id === paneId ? 1 : undefined;
    const isHorizontal = node.direction === 'horizontal';
    const first = widthShareWithin(node.first, paneId);
    if (first !== undefined) return isHorizontal ? first * node.ratio : first;
    const second = widthShareWithin(node.second, paneId);
    if (second === undefined) return undefined;
    return isHorizontal ? second * (1 - node.ratio) : second;
}

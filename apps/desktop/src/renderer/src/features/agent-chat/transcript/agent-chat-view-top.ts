import {
    AGENT_CHAT_HISTORY_HEAD_ATTRIBUTE,
    AGENT_CHAT_SETTLED_TIMELINE_ATTRIBUTE,
} from './agent-chat-history';

/**
 * The first of `rows`, in document order, that reaches below `top`. Binary search, because the settled block can hold
 * thousands of entries and each measurement of one skipped by `content-visibility` is cheap but not free.
 */
function firstRowBelow(rows: HTMLCollection, top: number): HTMLElement | undefined {
    let low = 0;
    let high = rows.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (rows[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
        else high = middle;
    }
    const row = rows[low];
    return row instanceof HTMLElement ? row : undefined;
}

/**
 * The transcript entry at the top of a Chat view, the one to hold in place while a page of earlier history is put above
 * it. The history head is skipped: it stays at the very top as pages go in below it, so holding it would hold nothing.
 * A point probe cannot tell an entry from the gap between two, or from the blocks that contain all of them.
 */
export function agentChatEntryAtViewTop(
    view: HTMLElement,
    content: HTMLElement,
): HTMLElement | undefined {
    const { top } = view.getBoundingClientRect();
    for (const child of content.children) {
        if (
            !(child instanceof HTMLElement) ||
            child.hasAttribute(AGENT_CHAT_HISTORY_HEAD_ATTRIBUTE)
        )
            continue;
        if (child.getBoundingClientRect().bottom <= top) continue;
        if (!child.hasAttribute(AGENT_CHAT_SETTLED_TIMELINE_ATTRIBUTE)) return child;
        return firstRowBelow(child.children, top) ?? child;
    }
    return undefined;
}

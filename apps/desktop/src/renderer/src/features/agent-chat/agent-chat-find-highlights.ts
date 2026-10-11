/**
 * Names the stylesheet paints (`::highlight(agent-chat-find)` in `styles.css`).
 */
const MATCH_HIGHLIGHT = 'agent-chat-find';
const ACTIVE_HIGHLIGHT = 'agent-chat-find-active';

interface FindHighlights {
    ranges: readonly Range[];
    active: Range | undefined;
}

/**
 * Each open find bar's matches, by owner. `CSS.highlights` is one registry per document, and two Chats can be open side
 * by side in split panes, so every owner's ranges are painted together and removing one leaves the others lit.
 */
const owners = new Map<string, FindHighlights>();

function paint(): void {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    const matches = new Highlight();
    const active = new Highlight();
    for (const owner of owners.values()) {
        for (const range of owner.ranges) if (range !== owner.active) matches.add(range);
        if (owner.active) active.add(owner.active);
    }
    CSS.highlights.set(MATCH_HIGHLIGHT, matches);
    CSS.highlights.set(ACTIVE_HIGHLIGHT, active);
}

export function setAgentChatFindHighlights(owner: string, highlights: FindHighlights): void {
    owners.set(owner, highlights);
    paint();
}

export function clearAgentChatFindHighlights(owner: string): void {
    if (!owners.delete(owner)) return;
    paint();
}

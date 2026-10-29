/**
 * Names the stylesheet paints (`::highlight(agent-chat-find)` in `styles.css`).
 */
const MATCH_HIGHLIGHT = 'agent-chat-find';
const ACTIVE_HIGHLIGHT = 'agent-chat-find-active';

interface FindHighlights {
    /**
     * Static ranges: see `collectAgentChatFindRanges` for why a live `Range` must not be registered.
     */
    ranges: readonly AbstractRange[];
    active: AbstractRange | undefined;
}

/**
 * Each open find bar's matches, by owner. `CSS.highlights` is one registry per document, and two Chats can be open side
 * by side in split panes, so every owner's ranges are painted together and removing one leaves the others lit.
 */
const owners = new Map<string, FindHighlights>();

/**
 * The two registered `Highlight`s, created once and refilled in place: swapping in fresh instances on every repaint
 * would drop and re-register the whole registry entry, where refilling only invalidates the painted ranges.
 */
const state: { registered?: { matches: Highlight; active: Highlight } } = {};

function canPaintHighlights(): boolean {
    return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

function paint(): void {
    if (!canPaintHighlights()) return;
    if (owners.size === 0) {
        if (!state.registered) return;
        CSS.highlights.delete(MATCH_HIGHLIGHT);
        CSS.highlights.delete(ACTIVE_HIGHLIGHT);
        state.registered = undefined;
        return;
    }
    if (!state.registered) {
        state.registered = { matches: new Highlight(), active: new Highlight() };
        CSS.highlights.set(MATCH_HIGHLIGHT, state.registered.matches);
        CSS.highlights.set(ACTIVE_HIGHLIGHT, state.registered.active);
    }
    const { matches, active } = state.registered;
    matches.clear();
    active.clear();
    for (const owner of owners.values()) {
        for (const range of owner.ranges) if (range !== owner.active) matches.add(range);
        if (owner.active) active.add(owner.active);
    }
}

export function setAgentChatFindHighlights(owner: string, highlights: FindHighlights): void {
    owners.set(owner, highlights);
    paint();
}

export function clearAgentChatFindHighlights(owner: string): void {
    if (!owners.delete(owner)) return;
    paint();
}

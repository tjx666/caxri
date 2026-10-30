import { createContext } from 'react';

import { escapeRegExp, throttle } from 'es-toolkit';

import type { Translate } from '../../../i18n';
import type { AgentChatTimelineEntry } from '../transcript/agent-chat-timeline';

/**
 * A typed space also matches a no-break space: Monaco's `colorize` paints every space in a fenced code block as
 * `&nbsp;`, so a phrase copied from a code block (copying turns them back into spaces) would otherwise never match it.
 */
const SPACE_PATTERN = / /gu;

/**
 * Where each occurrence of `query` starts in `text`, ignoring case, without overlaps. Case-insensitive matching through
 * a regular expression keeps offsets aligned with `text`, which lowercasing both sides would not for characters whose
 * lowercase form has another length.
 */
export function agentChatFindOccurrences(text: string, query: string): number[] {
    if (!query) return [];
    return text
        .matchAll(
            new RegExp(escapeRegExp(query).replaceAll(SPACE_PATTERN, String.raw`[ \u00a0]`), 'giu'),
        )
        .map((match) => match.index)
        .toArray();
}

/**
 * One text node's span in the text of the block it belongs to.
 */
export interface AgentChatFindSpan {
    start: number;
    end: number;
}

/**
 * Where an occurrence at `offset` of `length` characters starts and ends, as a span index plus an offset inside that
 * span, so a match may cross inline elements such as `**bold**` inside a paragraph. `undefined` when it runs off the
 * end.
 */
export function locateAgentChatFindMatch(
    spans: readonly AgentChatFindSpan[],
    offset: number,
    length: number,
): { start: [number, number]; end: [number, number] } | undefined {
    const end = offset + length;
    const startIndex = spans.findIndex((span) => offset < span.end);
    const endIndex = spans.findIndex((span) => end <= span.end);
    if (startIndex === -1 || endIndex === -1) return undefined;
    return {
        start: [startIndex, offset - spans[startIndex].start],
        end: [endIndex, end - spans[endIndex].start],
    };
}

/**
 * `3/12`, `No results` when nothing matches (the Terminal's find bar words it the same), and nothing before a query is
 * typed. Find searches only the messages the pane has loaded, so while older history is not loaded (or cannot be shown
 * in Chat at all) an empty result says `No results in loaded messages` rather than claiming the whole conversation.
 */
export function agentChatFindCountLabel(
    query: string,
    count: number,
    activeIndex: number,
    t: Translate,
    { isPartial = false }: { isPartial?: boolean } = {},
): string {
    if (!query) return '';
    if (count === 0)
        return t(isPartial ? 'agentChat.find.noResultsLoaded' : 'agentChat.find.noResults');
    return `${activeIndex + 1}/${count}`;
}

/**
 * Whether the find bar offers Search earlier messages: a query found nothing in the loaded messages and older history
 * can still be loaded, so the empty result is not a dead end. History that cannot be shown in Chat at all (`truncated`)
 * offers nothing to load.
 */
export function canAgentChatFindSearchEarlier(
    query: string,
    count: number,
    canLoadEarlier: boolean,
): boolean {
    return query !== '' && count === 0 && canLoadEarlier;
}

/**
 * Whether a Search earlier messages request has run its course: the page of older history it asked for stopped loading
 * (loaded or failed) while the request still waited for a match. The request is then settled whether or not the page
 * held one; left waiting, the next match a streamed reply adds would scroll the reader away from where they are.
 */
export function hasAgentChatFindEarlierLoadSettled(
    wasLoading: boolean,
    isLoading: boolean,
    isAwaiting: boolean,
): boolean {
    return isAwaiting && wasLoading && !isLoading;
}

/**
 * What a Session search handoff does next while no loaded message matches its query: `load` the next older page, `wait`
 * for the conversation, a page in flight, or the snapshot that says whether older history exists, or `stop` once a
 * match was found or a page failed. Without a next page the history is exhausted or its snapshot has not arrived, so it
 * waits rather than giving up.
 */
export function nextAgentChatFindAutoLoad(state: {
    isActive: boolean;
    hasQuery: boolean;
    hasContent: boolean;
    matchCount: number;
    hasFailed: boolean;
    isLoading: boolean;
    canLoadEarlier: boolean;
    /**
     * Whether this search already requested an older page, so a missing next page now means the history ended.
     */
    hasLoaded?: boolean;
}): 'load' | 'wait' | 'stop' {
    if (!state.isActive || state.matchCount > 0) return 'stop';
    if (state.hasFailed) return 'stop';
    if (state.hasLoaded && !state.isLoading && !state.canLoadEarlier) return 'stop';
    if (!state.hasQuery || !state.hasContent || state.isLoading || !state.canLoadEarlier)
        return 'wait';
    return 'load';
}

/**
 * The match after (`delta` 1) or before (`delta` -1) `index`, wrapping around at either end.
 */
export function stepAgentChatFindIndex(index: number, count: number, delta: 1 | -1): number {
    if (count === 0) return 0;
    return (index + delta + count) % count;
}

/**
 * The shortest query that opens folded turns: one or two characters match nearly every message, and opening every fold
 * on the first keystroke would balloon the conversation the reader is in.
 */
const FOLD_QUERY_MIN_LENGTH = 3;

/**
 * Whether a folded turn holds a message that mentions `query`. Its entries are not in the DOM while it is folded, so
 * find opens the fold from the projection's text and then highlights what renders. Tool output inside a work row is not
 * read here: those rows stay folded until opened by hand.
 */
export function isAgentChatTurnFoldMatch(
    entry: Extract<AgentChatTimelineEntry, { kind: 'turn' }>,
    query: string,
): boolean {
    if (query.length < FOLD_QUERY_MIN_LENGTH) return false;
    return entry.entries.some(
        (child) =>
            child.kind === 'item' &&
            'text' in child.item &&
            typeof child.item.text === 'string' &&
            agentChatFindOccurrences(child.item.text, query).length > 0,
    );
}

/**
 * The query the Chat's open find bar searches for, empty while it is closed, so a folded turn can open when it holds a
 * match.
 */
export const AgentChatFindQueryContext = createContext('');

/**
 * The shortest gap between two find repaints that conversation DOM changes trigger. Every repaint walks all of the
 * conversation's text and rebuilds every match range, and a streaming reply changes the DOM many times a second, so a
 * long conversation repaints at most this often while it streams instead of on every frame.
 */
export const AGENT_CHAT_FIND_REPAINT_INTERVAL_MS = 250;

/**
 * Coalesces the find repaints that conversation DOM changes ask for. The first change after a quiet spell repaints at
 * once, so an opened fold shows its matches without delay; a run of changes, such as a streaming reply, repaints at
 * most once per {@link AGENT_CHAT_FIND_REPAINT_INTERVAL_MS} plus once after the last change, so the final text is always
 * searched. Typing a query and stepping through matches repaint directly and never wait for it.
 */
export function createAgentChatFindRepaintScheduler(repaint: () => void): {
    schedule: () => void;
    cancel: () => void;
} {
    const throttled = throttle(repaint, AGENT_CHAT_FIND_REPAINT_INTERVAL_MS);
    return {
        schedule: () => throttled(),
        cancel: () => throttled.cancel(),
    };
}

/**
 * Elements whose text is not what the reader sees: screen-reader-only labels, folded or hidden content, icons, and
 * anything a view opts out with `data-agent-chat-find-ignore`.
 */
const IGNORED_SELECTOR = '.sr-only, [hidden], [inert], svg, [data-agent-chat-find-ignore]';

/**
 * Elements that start a new run of text: a match never spans two paragraphs, list items, or code blocks.
 */
const BLOCK_TAGS = new Set([
    'ARTICLE',
    'BLOCKQUOTE',
    'BUTTON',
    'DIV',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'LI',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'TD',
    'TH',
    'TR',
    'UL',
]);

/**
 * Every occurrence of `query` in the text `container` shows, as DOM ranges in reading order. The rendered Markdown is
 * left alone: the ranges feed the CSS Custom Highlight API rather than wrapping matches in elements.
 *
 * The ranges are `StaticRange`s: a live `Range` is tracked by the document and adjusted on every DOM mutation, and 10k
 * of them are created on each repaint. Read geometry through {@link measureAgentChatFindRange}.
 */
export function collectAgentChatFindRanges(container: HTMLElement, query: string): StaticRange[] {
    if (!query) return [];
    const ranges: StaticRange[] = [];
    let text = '';
    let nodes: Text[] = [];
    let spans: AgentChatFindSpan[] = [];
    const flush = (): void => {
        for (const offset of agentChatFindOccurrences(text, query)) {
            const located = locateAgentChatFindMatch(spans, offset, query.length);
            const startNode = located && nodes[located.start[0]];
            const endNode = located && nodes[located.end[0]];
            if (!located || !startNode || !endNode) continue;
            ranges.push(
                new StaticRange({
                    startContainer: startNode,
                    startOffset: located.start[1],
                    endContainer: endNode,
                    endOffset: located.end[1],
                }),
            );
        }
        text = '';
        nodes = [];
        spans = [];
    };
    const visit = (node: Node): void => {
        if (node instanceof Text) {
            const value = node.data;
            spans.push({ start: text.length, end: text.length + value.length });
            nodes.push(node);
            text += value;
            return;
        }
        if (!(node instanceof Element) || node.matches(IGNORED_SELECTOR)) return;
        const isBlock = BLOCK_TAGS.has(node.tagName);
        if (isBlock) flush();
        for (const child of node.childNodes) visit(child);
        if (isBlock) flush();
    };
    visit(container);
    flush();
    return ranges;
}

/**
 * Selects `range`'s text in `scratch`, a live `Range` the caller reuses, so measuring a match never registers a new
 * live range in the document. `undefined` when the text the range points into has since changed under it.
 */
export function measureAgentChatFindRange(range: StaticRange, scratch: Range): DOMRect | undefined {
    try {
        scratch.setStart(range.startContainer, range.startOffset);
        scratch.setEnd(range.endContainer, range.endOffset);
    } catch {
        return undefined;
    }
    return scratch.getBoundingClientRect();
}

/**
 * How far past the view's top and bottom edges, as a fraction of the view's height, matches still get a highlight, so a
 * short scroll between two windowed repaints never shows bare text.
 */
export const AGENT_CHAT_FIND_HIGHLIGHT_MARGIN = 0.25;

/**
 * The matches whose rows touch the band `[top, bottom]`, as a half-open index range `[start, end)`. Matches are in
 * reading order, so their vertical positions only grow and two binary searches find the band in O(log n) measurements
 * instead of measuring every match. `measure` returns a match's top and bottom, or `undefined` when it cannot be
 * measured (its text changed under it), which counts as above the band.
 */
export function agentChatFindVisibleWindow(
    count: number,
    measure: (index: number) => { top: number; bottom: number } | undefined,
    top: number,
    bottom: number,
): [number, number] {
    // First match whose bottom is at or below the band's top.
    let low = 0;
    let high = count;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if ((measure(middle)?.bottom ?? -Infinity) >= top) high = middle;
        else low = middle + 1;
    }
    const start = low;
    // First match whose top is below the band's bottom.
    high = count;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if ((measure(middle)?.top ?? -Infinity) > bottom) high = middle;
        else low = middle + 1;
    }
    return [start, low];
}

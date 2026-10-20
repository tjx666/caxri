import type { RefObject } from 'react';
import {
    useCallback,
    useEffect,
    useEffectEvent,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';

import { notifyListeners } from '@caxri/utils';

import { registerTerminalSearchHandler } from '../../terminal/terminal-search';
import {
    collectAgentChatFindRanges,
    createAgentChatFindRepaintScheduler,
    hasAgentChatFindEarlierLoadSettled,
    stepAgentChatFindIndex,
} from '../find/agent-chat-find';
import {
    clearAgentChatFindHighlights,
    setAgentChatFindHighlights,
} from '../find/agent-chat-find-highlights';

/**
 * Where a revealed match lands in the view, as a fraction of its height from the top, so the lines before it stay in
 * sight for context.
 */
const REVEAL_FRACTION = 1 / 3;

interface FindResult {
    count: number;
    activeIndex: number;
}

/**
 * One find bar's matches. They live in the DOM, outside React, and are recomputed whenever the conversation's DOM
 * changes; the bar subscribes to the count and position they produce.
 */
interface FindSession {
    ranges: Range[];
    activeIndex: number;
    /**
     * Set by typing or stepping, consumed by the next paint: only those move the view. A streamed reply that adds a
     * match leaves the reader where they are.
     */
    pendingReveal: 'start' | 'active' | undefined;
    result: FindResult;
    listeners: Set<() => void>;
    /**
     * Set by Search earlier messages: older history is loading, and the first paint that finds a match reveals it. A
     * plain pending reveal would be spent by the repaint the loading indicator itself causes, before any match exists.
     * Cleared once that page stops loading (`hasAgentChatFindEarlierLoadSettled`), so a match a later streamed reply
     * adds does not scroll the view.
     */
    isAwaitingEarlier: boolean;
}

function createFindSession(): FindSession {
    return {
        ranges: [],
        activeIndex: 0,
        pendingReveal: undefined,
        result: { count: 0, activeIndex: 0 },
        listeners: new Set(),
        isAwaitingEarlier: false,
    };
}

function publish(session: FindSession, result: FindResult): void {
    if (result.count === session.result.count && result.activeIndex === session.result.activeIndex)
        return;
    session.result = result;
    // One throwing subscriber must not keep the find bar's other subscribers on a stale count; Desktop mirrors
    // `console.error` into `logs/desktop.jsonl`.
    notifyListeners(session.listeners, undefined, (error) =>
        console.error('agentChat.find listener failed', error),
    );
}

function requestReveal(session: FindSession, reveal: 'start' | 'active'): void {
    session.pendingReveal = reveal;
}

function setAwaitingEarlier(session: FindSession, isAwaiting: boolean): void {
    session.isAwaitingEarlier = isAwaiting;
}

/**
 * Moves the current match one step, wrapping around, and asks the next paint to reveal it. `false` when nothing
 * matches.
 */
function didStepFind(session: FindSession, delta: 1 | -1): boolean {
    if (session.ranges.length === 0) return false;
    session.activeIndex = stepAgentChatFindIndex(session.activeIndex, session.ranges.length, delta);
    requestReveal(session, 'active');
    return true;
}

/**
 * The first match at or below the top of the view, so a new query starts where the reader is rather than at the top of
 * a long conversation; the last match when every one is above.
 */
function firstVisibleMatch(ranges: readonly Range[], view: HTMLElement): number {
    const top = view.getBoundingClientRect().top;
    const index = ranges.findIndex((range) => range.getBoundingClientRect().bottom >= top);
    return index === -1 ? ranges.length - 1 : index;
}

function reveal(range: Range, view: HTMLElement): void {
    const viewRect = view.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    if (rect.top >= viewRect.top && rect.bottom <= viewRect.bottom) return;
    view.scrollTop += rect.top - viewRect.top - view.clientHeight * REVEAL_FRACTION;
}

/**
 * Recomputes `session`'s matches for `query` in `content`, paints them, and reveals the current one when a keystroke
 * asked for it.
 */
function paintFind({
    content,
    view,
    owner,
    query,
    session,
    stopFollowing,
}: {
    content: HTMLElement | null;
    view: HTMLElement | null;
    owner: string;
    query: string;
    session: FindSession;
    stopFollowing: () => void;
}): void {
    if (!content || !view || !query) {
        session.isAwaitingEarlier = false;
        session.ranges = [];
        clearAgentChatFindHighlights(owner);
        publish(session, { count: 0, activeIndex: 0 });
        return;
    }
    const ranges = collectAgentChatFindRanges(content, query);
    if (session.isAwaitingEarlier && ranges.length > 0) {
        // Loaded history sits above the view, so the first match at or below its top is the nearest earlier one.
        session.isAwaitingEarlier = false;
        requestReveal(session, 'start');
    }
    const index =
        session.pendingReveal === 'start'
            ? Math.max(firstVisibleMatch(ranges, view), 0)
            : Math.min(session.activeIndex, Math.max(ranges.length - 1, 0));
    const active = ranges.at(index);
    session.ranges = ranges;
    session.activeIndex = index;
    setAgentChatFindHighlights(owner, { ranges, active });
    publish(session, { count: ranges.length, activeIndex: index });
    if (active && session.pendingReveal) {
        stopFollowing();
        reveal(active, view);
    }
    session.pendingReveal = undefined;
}

/**
 * Find in a Chat: `Cmd+F` (the Terminal's own find command, which reaches the Chat a Terminal shows) opens the bar,
 * every occurrence of the query in the visible conversation is highlighted, and Enter steps through them, scrolling
 * each into view. Matches are recomputed as the conversation streams or a fold opens, keeping the current one by
 * position; a streaming reply repaints them at most every `AGENT_CHAT_FIND_REPAINT_INTERVAL_MS`, since each repaint
 * walks the whole conversation.
 */
export function useAgentChatFind({
    terminalId,
    scrollReference,
    contentReference,
    stopFollowing,
    focusComposer,
    isLoadingEarlier,
    loadEarlier,
}: {
    terminalId: string;
    scrollReference: RefObject<HTMLDivElement | null>;
    contentReference: RefObject<HTMLDivElement | null>;
    stopFollowing: () => void;
    focusComposer: () => void;
    /**
     * A page of older history is being read.
     */
    isLoadingEarlier: boolean;
    /**
     * Loads the next page of older history, or `undefined` when there is none to load.
     */
    loadEarlier?: () => void;
}) {
    const owner = useId();
    const [isOpen, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [focusRevision, setFocusRevision] = useState(0);
    const [session] = useState(createFindSession);
    const result = useSyncExternalStore(
        (listener) => {
            session.listeners.add(listener);
            return () => session.listeners.delete(listener);
        },
        () => session.result,
    );
    const searched = isOpen ? query : '';
    const paint = (): void =>
        paintFind({
            content: contentReference.current,
            view: scrollReference.current,
            owner,
            query: searched,
            session,
            stopFollowing,
        });

    useLayoutEffect(() => {
        paintFind({
            content: contentReference.current,
            view: scrollReference.current,
            owner,
            query: searched,
            session,
            stopFollowing,
        });
    }, [contentReference, owner, scrollReference, searched, session, stopFollowing]);
    useEffect(() => {
        const content = contentReference.current;
        if (!content || !searched) return;
        const repaints = createAgentChatFindRepaintScheduler(() =>
            paintFind({
                content,
                view: scrollReference.current,
                owner,
                query: searched,
                session,
                stopFollowing,
            }),
        );
        const observer = new MutationObserver(repaints.schedule);
        observer.observe(content, { characterData: true, childList: true, subtree: true });
        return () => {
            observer.disconnect();
            repaints.cancel();
        };
    }, [contentReference, owner, scrollReference, searched, session, stopFollowing]);
    useEffect(() => () => clearAgentChatFindHighlights(owner), [owner]);
    const wasLoadingEarlier = useRef(isLoadingEarlier);
    const settleEarlierLoad = useEffectEvent((wasLoading: boolean): void => {
        if (
            !hasAgentChatFindEarlierLoadSettled(
                wasLoading,
                isLoadingEarlier,
                session.isAwaitingEarlier,
            )
        )
            return;
        // Paint the loaded page now, so a match it holds is still revealed, then stop waiting either way.
        paint();
        setAwaitingEarlier(session, false);
    });
    useLayoutEffect(() => {
        const wasLoading = wasLoadingEarlier.current;
        wasLoadingEarlier.current = isLoadingEarlier;
        settleEarlierLoad(wasLoading);
    }, [isLoadingEarlier]);

    const open = useCallback(() => {
        setOpen(true);
        setFocusRevision((revision) => revision + 1);
    }, []);
    useEffect(() => registerTerminalSearchHandler(terminalId, open), [open, terminalId]);

    const changeQuery = (next: string): void => {
        setAwaitingEarlier(session, false);
        requestReveal(session, 'start');
        setQuery(next);
    };
    const step = (delta: 1 | -1): void => {
        if (didStepFind(session, delta)) paint();
    };
    const close = (): void => {
        setOpen(false);
        focusComposer();
    };
    return {
        /**
         * What the conversation's folds compare their text with, empty while the bar is closed.
         */
        searched,
        bar: isOpen
            ? {
                  activeIndex: result.activeIndex,
                  count: result.count,
                  focusRevision,
                  query,
                  onClose: close,
                  onNext: () => step(1),
                  onPrevious: () => step(-1),
                  onQueryChange: changeQuery,
                  onSearchEarlier: loadEarlier
                      ? () => {
                            setAwaitingEarlier(session, true);
                            loadEarlier();
                        }
                      : undefined,
              }
            : undefined,
    };
}

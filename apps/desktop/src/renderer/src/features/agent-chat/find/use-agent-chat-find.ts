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
import { throttle } from 'es-toolkit';

import { registerTerminalSearchHandler } from '../../terminal/terminal-search';
import {
    AGENT_CHAT_FIND_HIGHLIGHT_MARGIN,
    agentChatFindVisibleWindow,
    collectAgentChatFindRanges,
    createAgentChatFindRepaintScheduler,
    hasAgentChatFindEarlierLoadSettled,
    measureAgentChatFindRange,
    nextAgentChatFindAutoLoad,
    stepAgentChatFindIndex,
} from './agent-chat-find';
import { registerAgentChatFindHandoff } from './agent-chat-find-handoff';
import {
    clearAgentChatFindHighlights,
    setAgentChatFindHighlights,
} from './agent-chat-find-highlights';

/**
 * Where a revealed match lands in the view, as a fraction of its height from the top, so the lines before it stay in
 * sight for context.
 */
const REVEAL_FRACTION = 1 / 3;

/**
 * The shortest gap between two highlight window updates that scrolling triggers.
 */
const AGENT_CHAT_FIND_WINDOW_INTERVAL_MS = 80;

interface FindResult {
    count: number;
    activeIndex: number;
}

/**
 * One find bar's matches. They live in the DOM, outside React, and are recomputed whenever the conversation's DOM
 * changes; the bar subscribes to the count and position they produce.
 */
interface FindSession {
    ranges: StaticRange[];
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
    /**
     * Set by a Session search handoff: when the loaded messages hold no match, older pages keep loading one after
     * another until a match appears, the history ends, or a page fails. Typing, closing, or the first match clears it.
     */
    isAutoLoadingEarlier: boolean;
}

function createFindSession(): FindSession {
    return {
        ranges: [],
        activeIndex: 0,
        pendingReveal: undefined,
        result: { count: 0, activeIndex: 0 },
        listeners: new Set(),
        isAwaitingEarlier: false,
        isAutoLoadingEarlier: false,
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

function setAutoLoadingEarlier(session: FindSession, isAutoLoading: boolean): void {
    session.isAutoLoadingEarlier = isAutoLoading;
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
function firstVisibleMatch(ranges: readonly StaticRange[], view: HTMLElement): number {
    const top = view.getBoundingClientRect().top;
    const scratch = view.ownerDocument.createRange();
    const index = ranges.findIndex(
        (range) => (measureAgentChatFindRange(range, scratch)?.bottom ?? -Infinity) >= top,
    );
    return index === -1 ? ranges.length - 1 : index;
}

function reveal(range: StaticRange, view: HTMLElement): void {
    const viewRect = view.getBoundingClientRect();
    const rect = measureAgentChatFindRange(range, view.ownerDocument.createRange());
    if (!rect) return;
    if (rect.top >= viewRect.top && rect.bottom <= viewRect.bottom) return;
    view.scrollTop += rect.top - viewRect.top - view.clientHeight * REVEAL_FRACTION;
}

/**
 * Paints the matches near the view, plus the current one wherever it is. Painting highlights costs time in proportion
 * to how many are registered, on every frame a streaming reply paints (a Chat with about 10k matches spent 3 s of
 * PrePaint and 3 s of Paint in an 8 s trace, about 12 fps; the 800 or so matches near the view cost 2 s of Paint and no
 * frame rate), so the matches far above or below the view stay unregistered until a scroll brings them near; the count,
 * stepping, and reveal keep using all of them.
 */
function paintFindHighlights(owner: string, view: HTMLElement, session: FindSession): void {
    const scratch = view.ownerDocument.createRange();
    const viewRect = view.getBoundingClientRect();
    const margin = viewRect.height * AGENT_CHAT_FIND_HIGHLIGHT_MARGIN;
    const [start, end] = agentChatFindVisibleWindow(
        session.ranges.length,
        (index) => measureAgentChatFindRange(session.ranges[index], scratch),
        viewRect.top - margin,
        viewRect.bottom + margin,
    );
    setAgentChatFindHighlights(owner, {
        ranges: session.ranges.slice(start, end),
        active: session.ranges.at(session.activeIndex),
    });
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
        session.isAutoLoadingEarlier = false;
        session.ranges = [];
        clearAgentChatFindHighlights(owner);
        publish(session, { count: 0, activeIndex: 0 });
        return;
    }
    const ranges = collectAgentChatFindRanges(content, query);
    if (ranges.length > 0) session.isAutoLoadingEarlier = false;
    const isEarlierPageMatch = session.isAwaitingEarlier && ranges.length > 0;
    if (isEarlierPageMatch) {
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
    paintFindHighlights(owner, view, session);
    publish(session, { count: ranges.length, activeIndex: index });
    if (active && session.pendingReveal) {
        stopFollowing();
        reveal(active, view);
        if (isEarlierPageMatch) {
            // The pane puts the reader's previous view top back in a layout effect that runs after this one in the
            // same commit, which would scroll the match away again; reveal once that commit has finished.
            queueMicrotask(() => {
                const current = session.ranges.at(session.activeIndex);
                if (current && view.isConnected) reveal(current, view);
            });
        }
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
    agentSessionId,
    terminalId,
    scrollReference,
    contentReference,
    stopFollowing,
    focusComposer,
    isLoadingEarlier,
    hasEarlierLoadFailed,
    loadEarlier,
    onOpen,
}: {
    /**
     * The provider conversation shown, so a Session search result can open find here with its query.
     */
    agentSessionId: string | undefined;
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
     * The last page of older history failed to load, which stops a handoff from loading further pages on its own.
     */
    hasEarlierLoadFailed: boolean;
    /**
     * Loads the next page of older history, or `undefined` when there is none to load.
     */
    loadEarlier?: () => void;
    /**
     * Called when the bar opens, before any match is searched: the conversation mounts every entry so find sees them.
     */
    onOpen?: () => void;
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
        // Scrolling moves which matches are near the view, so the highlights follow it, without searching again.
        const view = scrollReference.current;
        const rewindow = throttle(() => {
            if (view) paintFindHighlights(owner, view, session);
        }, AGENT_CHAT_FIND_WINDOW_INTERVAL_MS);
        view?.addEventListener('scroll', rewindow, { passive: true });
        return () => {
            observer.disconnect();
            repaints.cancel();
            view?.removeEventListener('scroll', rewindow);
            rewindow.cancel();
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

    const canLoadEarlier = loadEarlier !== undefined;
    const autoLoadEarlier = useEffectEvent((): void => {
        const next = nextAgentChatFindAutoLoad({
            isActive: session.isAutoLoadingEarlier,
            hasQuery: searched !== '',
            hasContent: Boolean(contentReference.current?.textContent),
            matchCount: session.ranges.length,
            hasFailed: hasEarlierLoadFailed,
            isLoading: isLoadingEarlier,
            canLoadEarlier,
        });
        if (next === 'stop') setAutoLoadingEarlier(session, false);
        if (next !== 'load') return;
        setAwaitingEarlier(session, true);
        loadEarlier?.();
    });
    // Runs after the layout effects above have painted the page that just loaded, so `session.ranges` is current.
    useEffect(() => {
        autoLoadEarlier();
    }, [isLoadingEarlier, canLoadEarlier, hasEarlierLoadFailed, searched, result.count]);

    const open = useCallback(() => {
        onOpen?.();
        setOpen(true);
        setFocusRevision((revision) => revision + 1);
    }, [onOpen]);
    useEffect(() => registerTerminalSearchHandler(terminalId, open), [open, terminalId]);
    /**
     * A handed-off query arrives before the conversation has rendered, so it waits for the first paint that finds a
     * match to reveal it, the same way Search earlier messages does.
     */
    const openWithQuery = useCallback(
        (next: string) => {
            setAwaitingEarlier(session, true);
            setAutoLoadingEarlier(session, true);
            requestReveal(session, 'start');
            setQuery(next);
            open();
        },
        [open, session],
    );
    useEffect(
        () =>
            agentSessionId
                ? registerAgentChatFindHandoff(agentSessionId, openWithQuery)
                : undefined,
        [agentSessionId, openWithQuery],
    );

    const changeQuery = (next: string): void => {
        setAwaitingEarlier(session, false);
        setAutoLoadingEarlier(session, false);
        requestReveal(session, 'start');
        setQuery(next);
    };
    const step = (delta: 1 | -1): void => {
        if (didStepFind(session, delta)) paint();
    };
    const close = (): void => {
        setAutoLoadingEarlier(session, false);
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

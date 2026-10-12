import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { motionSettleTimeoutMs } from '../../../lib/motion';

/**
 * How close to the end still counts as "following" the conversation. A few pixels of slack absorbs sub-pixel layout and
 * the last line growing by one wrap while a reply streams.
 */
export const AGENT_CHAT_FOLLOW_THRESHOLD_PX = 24;

export function isScrolledToEnd(
    metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
    threshold = AGENT_CHAT_FOLLOW_THRESHOLD_PX,
): boolean {
    return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

/**
 * Where a following view scrolls to after a layout change: the end of its content, or `null` while the user reads
 * history. The end moves both when the content grows and when the view itself shrinks (a dock below it expanding a diff
 * or the plan), and either one would otherwise leave the latest entry clipped under the dock.
 */
export function agentChatFollowScrollTop(
    metrics: { scrollHeight: number; clientHeight: number },
    isFollowing: boolean,
): number | null {
    return isFollowing ? Math.max(metrics.scrollHeight - metrics.clientHeight, 0) : null;
}

/**
 * Where to scroll so an anchored row stays where the user clicked it: the row's offset from the view's top was
 * `anchoredOffset` when they clicked, and is `currentOffset` after the layout changed.
 */
export function agentChatAnchoredScrollTop(
    scrollTop: number,
    anchoredOffset: number,
    currentOffset: number,
): number {
    return Math.max(scrollTop + currentOffset - anchoredOffset, 0);
}

/**
 * How far below the view's top the latest user message rests once the view reaches the end.
 */
const AGENT_CHAT_TURN_TOP_GAP_PX = 16;

/**
 * The empty space kept below the latest turn so it can rest at the top of the view, as ChatGPT and the Codex app show a
 * sent message: `turnHeight` runs from that turn's user message to the end of the content. A reply then grows into the
 * space instead of pushing the message up from the bottom, and once it outgrows the view the space is gone and
 * following the end takes over.
 */
export function agentChatTurnSpacerHeight(
    viewHeight: number,
    turnHeight: number,
    topGap = AGENT_CHAT_TURN_TOP_GAP_PX,
): number {
    return Math.max(viewHeight - turnHeight - topGap, 0);
}

function offsetInView(view: HTMLElement, element: HTMLElement): number {
    return element.getBoundingClientRect().top - view.getBoundingClientRect().top;
}

/**
 * Keeps the timeline pinned to its end while the user is reading the end, and leaves it alone once they scroll up to
 * read history. `revision` changes with every streamed patch, so following is re-applied after each layout; a resize of
 * the content (an expanded tool row, a narrower pane re-wrapping text) moves the end without a new revision, so the
 * content is observed too. So is the scroll view itself: a dock below it growing shrinks the view without changing the
 * content, and the end must stay in sight. With `turnSelector` (the Chat's user messages), the space below the latest
 * turn keeps it at the top of the view at the end, so a sent message rises to the top and its reply fills in below it.
 * `isFollowing` drives the "Jump to latest" control shown while reading history.
 *
 * Expanding or collapsing a row is the user reading, not the conversation moving: `anchor` stops following and keeps
 * the clicked row where it is while the disclosure animates, instead of pinning the end and sliding the row away.
 * Following resumes once a later revision finds the view at the end, or on Jump to latest.
 */
export function useAgentChatScroll(
    revision: number | undefined,
    { turnSelector }: { turnSelector?: string } = {},
): {
    scrollReference: RefObject<HTMLDivElement | null>;
    contentReference: RefObject<HTMLDivElement | null>;
    /**
     * An empty element after the content, sized by {@link agentChatTurnSpacerHeight} when `turnSelector` is given. It
     * sits outside the observed content so resizing it never re-triggers a layout pass.
     */
    spacerReference: RefObject<HTMLDivElement | null>;
    isFollowing: boolean;
    onScroll: () => void;
    jumpToLatest: () => void;
    /**
     * Stops following before a programmatic scroll into history, so a patch landing mid-scroll does not pin the view
     * back to the end before the scroll's own event reports the new position.
     */
    stopFollowing: () => void;
    /**
     * Stops following and holds `element` at its current place in the view while the layout around it settles.
     */
    anchor: (element: HTMLElement) => void;
} {
    const scrollReference = useRef<HTMLDivElement | null>(null);
    const contentReference = useRef<HTMLDivElement | null>(null);
    const spacerReference = useRef<HTMLDivElement | null>(null);
    const isFollowingReference = useRef(true);
    const [isFollowing, setFollowing] = useState(true);
    const anchorReference = useRef<{ element: HTMLElement; offset: number; until: number }>(
        undefined,
    );
    const pin = useCallback(() => {
        const element = scrollReference.current;
        if (!element) return;
        const content = contentReference.current;
        const spacer = spacerReference.current;
        if (turnSelector && content && spacer) {
            const turns = content.querySelectorAll<HTMLElement>(turnSelector);
            const turn = turns.item(turns.length - 1) as HTMLElement | null;
            const height = turn
                ? agentChatTurnSpacerHeight(
                      element.clientHeight,
                      content.getBoundingClientRect().bottom - turn.getBoundingClientRect().top,
                  )
                : 0;
            spacer.style.height = `${height}px`;
        }
        const anchored = anchorReference.current;
        if (anchored && (performance.now() > anchored.until || !anchored.element.isConnected))
            anchorReference.current = undefined;
        else if (anchored) {
            element.scrollTop = agentChatAnchoredScrollTop(
                element.scrollTop,
                anchored.offset,
                offsetInView(element, anchored.element),
            );
            return;
        }
        const top = agentChatFollowScrollTop(element, isFollowingReference.current);
        if (top !== null) element.scrollTop = top;
    }, [turnSelector]);
    const onScroll = useCallback(() => {
        const element = scrollReference.current;
        if (!element) return;
        isFollowingReference.current = isScrolledToEnd(element);
        setFollowing(isFollowingReference.current);
    }, []);
    const jumpToLatest = useCallback(() => {
        anchorReference.current = undefined;
        isFollowingReference.current = true;
        setFollowing(true);
        pin();
    }, [pin]);
    const stopFollowing = useCallback(() => {
        isFollowingReference.current = false;
        setFollowing(false);
    }, []);
    const anchor = useCallback((element: HTMLElement) => {
        const view = scrollReference.current;
        if (!view) return;
        isFollowingReference.current = false;
        setFollowing(false);
        anchorReference.current = {
            element,
            offset: offsetInView(view, element),
            // The disclosure animates its height for at most this long; after that the row is left alone.
            until:
                performance.now() +
                Math.max(
                    motionSettleTimeoutMs('--motion-expand'),
                    motionSettleTimeoutMs('--motion-collapse'),
                ),
        };
    }, []);
    useLayoutEffect(() => {
        const element = scrollReference.current;
        if (element && !isFollowingReference.current && isScrolledToEnd(element)) {
            isFollowingReference.current = true;
            setFollowing(true);
        }
        pin();
    }, [pin, revision]);
    useEffect(() => {
        const content = contentReference.current;
        const view = scrollReference.current;
        if (!content || !view) return;
        const observer = new ResizeObserver(pin);
        observer.observe(content);
        observer.observe(view);
        return () => observer.disconnect();
    }, [pin]);
    return {
        scrollReference,
        contentReference,
        spacerReference,
        isFollowing,
        onScroll,
        jumpToLatest,
        stopFollowing,
        anchor,
    };
}

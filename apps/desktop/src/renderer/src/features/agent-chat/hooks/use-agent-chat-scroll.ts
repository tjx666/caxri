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
 * Whether the view follows the end after a scroll event, given `lastScrollTop`, where the view was last put or seen.
 * Only a scroll up leaves the end, yet a scroll event can report a position nobody scrolled up to, a frame after the
 * content below already grew: Send's own scroll to the end, reported once the pending message rendered, or Chromium's
 * scroll anchoring pushing the view down a few pixels to hold its place when a row above changes height as the message
 * is sent. Judged by position alone, either reads as the user scrolling up and stops following just as the message
 * should rise to the top. So while following, a scroll that kept or moved the view down keeps following, and only a
 * scroll up is judged by where it left the view. Reaching the end resumes following either way, as when a row collapsed
 * at the end and the view held it there.
 */
export function isFollowingAfterScroll(
    metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
    { isFollowing, lastScrollTop }: { isFollowing: boolean; lastScrollTop: number | undefined },
): boolean {
    // A pixel of slack absorbs fractional positions rounding differently between writing and reading back.
    const hasNotMovedUp = lastScrollTop !== undefined && metrics.scrollTop >= lastScrollTop - 1;
    return (isFollowing && hasNotMovedUp) || isScrolledToEnd(metrics);
}

/**
 * Whether the end of the content (the latest entry, not the empty space kept below the latest turn) is within the view.
 * `contentBottom` is that end's offset from the view's top. While it is, Jump to latest has nothing to bring into view:
 * scrolling up a little inside the kept space still shows the whole latest turn.
 */
export function isLatestInView(
    metrics: { contentBottom: number; viewHeight: number },
    threshold = AGENT_CHAT_FOLLOW_THRESHOLD_PX,
): boolean {
    return metrics.contentBottom - metrics.viewHeight <= threshold;
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
 * How far below the view's top the latest user message rests once the view reaches the end. Like the Codex app, it
 * leaves the last lines of the previous reply in view, so a sent message keeps the context it answers instead of
 * starting a blank page.
 */
const AGENT_CHAT_TURN_TOP_GAP_PX = 112;

/**
 * The empty space kept below the latest turn so it can rest at the top of the view, as ChatGPT and the Codex app show a
 * sent message: `turnHeight` runs from that turn's user message to the end of the content. A reply then grows into the
 * space instead of pushing the message up from the bottom, and once it outgrows the view the space is gone and
 * following the end takes over. The space is kept only while the turn is live; see `useAgentChatScroll`.
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
 * Like the Codex app, that space lasts only while the turn is live (`isTurnLive`): once it ends, and in a Chat opened
 * idle, the content rests on the view's bottom instead of leaving a blank view to scroll through. `isLatestInView`
 * hides the "Jump to latest" control while following or while the latest entry is still on screen.
 *
 * Expanding or collapsing a row is the user reading, not the conversation moving: `anchor` stops following and keeps
 * the clicked row where it is while the disclosure animates, instead of pinning the end and sliding the row away.
 * Following resumes once a later revision finds the view at the end, or on Jump to latest.
 */
export function useAgentChatScroll(
    revision: number | undefined,
    {
        isTurnLive = false,
        turnSelector,
    }: {
        /**
         * Whether the latest turn is still on its way: sent and not yet answered, streaming, or waiting on the user.
         * The space below it is kept only while it is.
         */
        isTurnLive?: boolean;
        turnSelector?: string;
    } = {},
): {
    scrollReference: RefObject<HTMLDivElement | null>;
    contentReference: RefObject<HTMLDivElement | null>;
    /**
     * An empty element after the content, sized by {@link agentChatTurnSpacerHeight} when `turnSelector` is given. It
     * sits outside the observed content so resizing it never re-triggers a layout pass.
     */
    spacerReference: RefObject<HTMLDivElement | null>;
    /**
     * Following the end, or scrolled away from it with the latest entry still in view. Only when this is false does
     * Jump to latest have something to bring back.
     */
    isLatestInView: boolean;
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
    const [isLatestVisible, setLatestVisible] = useState(true);
    const syncLatestInView = useCallback(() => {
        const view = scrollReference.current;
        const content = contentReference.current;
        setLatestVisible(
            isFollowingReference.current ||
                !view ||
                !content ||
                isLatestInView({
                    contentBottom:
                        content.getBoundingClientRect().bottom - view.getBoundingClientRect().top,
                    viewHeight: view.clientHeight,
                }),
        );
    }, []);
    const anchorReference = useRef<{ element: HTMLElement; offset: number; until: number }>(
        undefined,
    );
    /**
     * Where the view was last put or seen, so a scroll event can tell whether it moved up (see
     * {@link isFollowingAfterScroll}).
     */
    const lastScrollTopReference = useRef<number | undefined>(undefined);
    const pin = useCallback(() => {
        const element = scrollReference.current;
        if (!element) return;
        const content = contentReference.current;
        const spacer = spacerReference.current;
        if (turnSelector && content && spacer) {
            const turns = content.querySelectorAll<HTMLElement>(turnSelector);
            const turn = turns.item(turns.length - 1) as HTMLElement | null;
            const height =
                turn && isTurnLive
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
            lastScrollTopReference.current = element.scrollTop;
            return;
        }
        const top = agentChatFollowScrollTop(element, isFollowingReference.current);
        if (top === null) return;
        element.scrollTop = top;
        lastScrollTopReference.current = element.scrollTop;
    }, [isTurnLive, turnSelector]);
    const onScroll = useCallback(() => {
        const element = scrollReference.current;
        if (!element) return;
        isFollowingReference.current = isFollowingAfterScroll(element, {
            isFollowing: isFollowingReference.current,
            lastScrollTop: lastScrollTopReference.current,
        });
        lastScrollTopReference.current = element.scrollTop;
        syncLatestInView();
    }, [syncLatestInView]);
    const jumpToLatest = useCallback(() => {
        anchorReference.current = undefined;
        isFollowingReference.current = true;
        pin();
        syncLatestInView();
    }, [pin, syncLatestInView]);
    const stopFollowing = useCallback(() => {
        isFollowingReference.current = false;
        syncLatestInView();
    }, [syncLatestInView]);
    const anchor = useCallback(
        (element: HTMLElement) => {
            const view = scrollReference.current;
            if (!view) return;
            isFollowingReference.current = false;
            syncLatestInView();
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
        },
        [syncLatestInView],
    );
    useLayoutEffect(() => {
        const element = scrollReference.current;
        if (element && !isFollowingReference.current && isScrolledToEnd(element))
            isFollowingReference.current = true;
        pin();
        syncLatestInView();
    }, [pin, revision, syncLatestInView]);
    useEffect(() => {
        const content = contentReference.current;
        const view = scrollReference.current;
        if (!content || !view) return;
        // A reply growing past the view's bottom, or the view shrinking, moves the latest entry out of sight.
        const observer = new ResizeObserver(() => {
            pin();
            syncLatestInView();
        });
        observer.observe(content);
        observer.observe(view);
        return () => observer.disconnect();
    }, [pin, syncLatestInView]);
    return {
        scrollReference,
        contentReference,
        spacerReference,
        isLatestInView: isLatestVisible,
        onScroll,
        jumpToLatest,
        stopFollowing,
        anchor,
    };
}

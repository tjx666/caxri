import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { motionSettleTimeoutMs } from '../../../lib/motion';
import {
    hideScrollbarWhileSettling,
    isScrollbarSettling,
    scrollWithoutScrollbarFlash,
} from '../../../lib/quiet-scroll';

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
 * How far a positioned view's bottom is pulled up from its container's, such as the Chat pane's view ending above the
 * return hint. The latest entry counts as in view against the view's full slot: measured against the shortened view, a
 * scroll just past the threshold hid the hint, which gave the view its slot back and brought the latest entry into
 * view, which showed the hint again, so the view shook while the user tried to scroll up.
 */
function viewBottomInset(view: HTMLElement): number {
    // A computed inset reads as pixels (`40px`), or `auto` for a view that is not positioned.
    const inset = Number(getComputedStyle(view).bottom.replace(/px$/u, ''));
    return Number.isFinite(inset) && inset > 0 ? inset : 0;
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
 * following the end takes over. Once the turn ends the space only shrinks; see {@link agentChatSettledSpacerHeight}.
 */
export function agentChatTurnSpacerHeight(
    viewHeight: number,
    turnHeight: number,
    topGap = AGENT_CHAT_TURN_TOP_GAP_PX,
): number {
    return Math.max(viewHeight - turnHeight - topGap, 0);
}

/**
 * The space kept below the latest turn once it is no longer live: `turnSpaceHeight` ({@link agentChatTurnSpacerHeight}),
 * trimmed to the part still at or above the view's bottom (`viewBottom - contentEnd`, both in the scroll content's
 * coordinates). Like the Codex app, a turn ending neither moves the view nor drops the space under it; scrolling back
 * through history consumes the space by as much as the view moved, and it never grows back. A Chat opened idle starts
 * at its end, below which nothing is kept. Measuring against the turn's height rather than the previous space keeps the
 * view still when the finished turn folds its work rows: the turn shrinks, and the space grows by the same amount.
 */
export function agentChatSettledSpacerHeight({
    contentEnd,
    turnSpaceHeight,
    viewBottom,
}: {
    contentEnd: number;
    turnSpaceHeight: number;
    viewBottom: number;
}): number {
    return Math.max(Math.min(turnSpaceHeight, viewBottom - contentEnd), 0);
}

/**
 * Whether a prompt id reaching the view starts a turn the user should see: any change after the first id seen. The
 * first one is the conversation loading, which the view already shows from its end.
 */
export function isNewAgentChatPrompt(
    seenPromptId: string | undefined,
    latestPromptId: string | undefined,
): boolean {
    return seenPromptId !== undefined && latestPromptId !== seenPromptId;
}

/**
 * Whether a follow scroll catches the view up rather than tracking a reply as it streams: the first move the view ever
 * makes (a Chat opening onto its end), a jump of more than one screen (a Chat that grew while it was off screen, a long
 * block landing at once), or the view itself changing size (`isViewResize`: the composer strip folding away once an
 * opened Chat finishes starting, a dock below expanding). The user scrolled none of them, so such a move must not flash
 * the overlay scrollbar; a streaming reply moves the view a few lines at a time, and there the scrollbar keeps showing
 * the motion as before.
 */
export function isAgentChatCatchUpScroll({
    from,
    hasMoved,
    isViewResize = false,
    to,
    viewHeight,
}: {
    from: number;
    hasMoved: boolean;
    isViewResize?: boolean;
    to: number;
    viewHeight: number;
}): boolean {
    return !hasMoved || isViewResize || Math.abs(to - from) > viewHeight;
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
 * Like the Codex app, that space follows the turn only while it is live (`isTurnLive`): once it ends, the view stays
 * where it is and scrolling back through history consumes the space (see {@link agentChatSettledSpacerHeight}), while a
 * Chat opened idle rests on the view's bottom instead of leaving a blank view to scroll through. `isLatestInView` hides
 * the "Jump to latest" control while following or while the latest entry is still on screen.
 *
 * Expanding or collapsing a row is the user reading, not the conversation moving: `anchor` stops following and keeps
 * the clicked row where it is while the disclosure animates, instead of pinning the end and sliding the row away.
 * Following resumes once a later revision finds the view at the end, on Jump to latest, or when a new prompt starts a
 * turn (`latestPromptId` changes): a queued message delivered after the user scrolled up, or one sent from the phone,
 * rises into view like a message sent here instead of landing below the fold behind Jump to latest.
 */
export function useAgentChatScroll(
    revision: number | undefined,
    {
        isTurnLive = false,
        latestPromptId,
        turnSelector,
    }: {
        /**
         * Whether the latest turn is still on its way: sent and not yet answered, streaming, or waiting on the user.
         * The space below it follows the turn only while it is; afterwards it only shrinks.
         */
        isTurnLive?: boolean;
        /**
         * The newest user message's id. A change after the first one seen resumes following.
         */
        latestPromptId?: string;
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
                    viewHeight: view.clientHeight + viewBottomInset(view),
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
    /**
     * Whether the view has ever left its top, by the user or by following; see {@link isAgentChatCatchUpScroll}.
     */
    const hasMovedReference = useRef(false);
    const sizeSpacer = useCallback(
        /**
         * @param scrollTop Where the view was last put or seen, not where it is now: a finished turn folding shrinks
         *   the content first, and the browser has already clamped the view up by as much before the space grows back.
         */
        (scrollTop: number) => {
            const element = scrollReference.current;
            const content = contentReference.current;
            const spacer = spacerReference.current;
            // A hidden Chat measures a zero-height view; sizing against it would drop the space a finished turn kept.
            if (!element || !content || !spacer || !turnSelector || element.clientHeight === 0)
                return;
            const turns = content.querySelectorAll<HTMLElement>(turnSelector);
            const turn = turns.item(turns.length - 1) as HTMLElement | null;
            const contentRect = content.getBoundingClientRect();
            const turnSpaceHeight = turn
                ? agentChatTurnSpacerHeight(
                      element.clientHeight,
                      contentRect.bottom - turn.getBoundingClientRect().top,
                  )
                : 0;
            const height = isTurnLive
                ? turnSpaceHeight
                : agentChatSettledSpacerHeight({
                      contentEnd:
                          contentRect.bottom -
                          element.getBoundingClientRect().top +
                          element.scrollTop,
                      turnSpaceHeight,
                      viewBottom: scrollTop + element.clientHeight,
                  });
            // Runs on every scroll event, so an unchanged height is not written back to invalidate layout.
            const next = `${height}px`;
            if (spacer.style.height !== next) spacer.style.height = next;
        },
        [isTurnLive, turnSelector],
    );
    const pin = useCallback(
        /**
         * @param isViewResize Only the view changed size, not the content; see {@link isAgentChatCatchUpScroll}.
         */
        (isViewResize = false) => {
            const element = scrollReference.current;
            if (!element) return;
            // Rows still settling after the Chat opened move the view without the user; see `hideScrollbarWhileSettling`.
            if (isScrollbarSettling(element)) hideScrollbarWhileSettling(element);
            sizeSpacer(lastScrollTopReference.current ?? element.scrollTop);
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
            const isCatchUp =
                Math.abs(top - element.scrollTop) >= 1 &&
                (isViewResize ||
                    isAgentChatCatchUpScroll({
                        from: element.scrollTop,
                        hasMoved: hasMovedReference.current,
                        to: top,
                        viewHeight: element.clientHeight,
                    }));
            if (isCatchUp) scrollWithoutScrollbarFlash(element, top);
            else element.scrollTop = top;
            // The Chat just opened onto its end; its rows finish laying out over the next frames.
            if (!hasMovedReference.current && element.scrollTop > 0)
                hideScrollbarWhileSettling(element);
            if (element.scrollTop > 0) hasMovedReference.current = true;
            lastScrollTopReference.current = element.scrollTop;
        },
        [sizeSpacer],
    );
    const onScroll = useCallback(() => {
        const element = scrollReference.current;
        if (!element) return;
        if (isScrollbarSettling(element)) hideScrollbarWhileSettling(element);
        if (element.scrollTop > 0) hasMovedReference.current = true;
        // Scrolling back through a finished turn consumes the space below it, which leaves the view at the new end.
        sizeSpacer(element.scrollTop);
        isFollowingReference.current = isFollowingAfterScroll(element, {
            isFollowing: isFollowingReference.current,
            lastScrollTop: lastScrollTopReference.current,
        });
        lastScrollTopReference.current = element.scrollTop;
        syncLatestInView();
    }, [sizeSpacer, syncLatestInView]);
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
    const seenPromptIdReference = useRef(latestPromptId);
    useLayoutEffect(() => {
        const element = scrollReference.current;
        if (element && !isFollowingReference.current && isScrolledToEnd(element))
            isFollowingReference.current = true;
        if (isNewAgentChatPrompt(seenPromptIdReference.current, latestPromptId)) {
            anchorReference.current = undefined;
            isFollowingReference.current = true;
        }
        if (latestPromptId !== undefined) seenPromptIdReference.current = latestPromptId;
        pin();
        syncLatestInView();
    }, [latestPromptId, pin, revision, syncLatestInView]);
    useEffect(() => {
        const content = contentReference.current;
        const view = scrollReference.current;
        if (!content || !view) return;
        // A reply growing past the view's bottom, or the view shrinking, moves the latest entry out of sight.
        const observer = new ResizeObserver((entries) => {
            const isViewResize = entries.every((entry) => entry.target === view);
            // The composer animating its height resizes the view every frame, and a taller view clamps the offset at
            // the end down each time; none of that is the user scrolling, so keep the scrollbar hidden through it.
            if (isViewResize) hideScrollbarWhileSettling(view);
            pin(isViewResize);
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

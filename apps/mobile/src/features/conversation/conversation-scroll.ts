/**
 * How far below the viewport's top the latest turn's first row rests once the list reaches its end, as Desktop's Agent
 * Chat rests a sent message (`agentChatTurnSpacerHeight` in the Desktop Renderer's `use-agent-chat-scroll.ts`).
 */
export const CONVERSATION_TURN_TOP_GAP = 16;

/**
 * The index of the newest row that starts a turn (a user message, or a message still on its way), or `-1` when the list
 * has none or the caller does not mark turns.
 */
export const latestConversationTurnStart = <Entry>(
    entries: readonly Entry[],
    isTurnStart: ((entry: Entry) => boolean) | undefined,
): number => {
    if (!isTurnStart) return -1;
    for (let index = entries.length - 1; index >= 0; index -= 1)
        if (isTurnStart(entries[index])) return index;
    return -1;
};

/**
 * The empty space kept after the rows so the latest turn can rest at the top of the viewport: a sent message rises to
 * the top and its reply grows into the space below it instead of pushing it up from the bottom. Once the turn outgrows
 * the viewport the space is gone and following the end takes over.
 *
 * `turnTop` and `contentHeight` are measured in the rows' own container (FlashList's child container, which excludes
 * the header and footer), so the turn runs from `turnTop` to `contentHeight`. `bottomInset` is the list content's
 * bottom padding, which sits between the rows and the spacer and so also counts against the space.
 */
export const conversationTurnSpacerHeight = ({
    bottomInset = 0,
    contentHeight,
    topGap = CONVERSATION_TURN_TOP_GAP,
    turnTop,
    viewportHeight,
}: {
    bottomInset?: number;
    contentHeight: number;
    topGap?: number;
    turnTop: number;
    viewportHeight: number;
}): number =>
    Math.max(Math.round(viewportHeight - (contentHeight - turnTop) - topGap - bottomInset), 0);

/**
 * Whether the list should read an older page on its own because its rows do not fill the viewport. A short list cannot
 * scroll far enough to reach its top, so the load-earlier header sits hidden above the bottom inset and the reader sees
 * a few rows under a blank band. Loading pages until the rows fill the viewport (or nothing older remains) avoids
 * that.
 */
export const shouldFillConversationWithOlder = ({
    contentHeight,
    hasOlder,
    isLoadingOlder,
    isPositioned,
    viewportHeight,
}: {
    contentHeight: number;
    hasOlder: boolean;
    isLoadingOlder: boolean;
    isPositioned: boolean;
    viewportHeight: number;
}): boolean =>
    isPositioned &&
    hasOlder &&
    !isLoadingOlder &&
    viewportHeight > 0 &&
    contentHeight < viewportHeight;

/**
 * Whether reaching the list's top reads an older page. A short list sits at its top while it follows its end, so only a
 * reader who left the end scrolls back; while following, `shouldFillConversationWithOlder` reads one page at a time
 * instead. A scroll-back reads several pages in a row, and each one shifted the followed rows before the list returned
 * to its end.
 */
export const shouldReadOlderAtConversationTop = ({
    hasOlder,
    isFollowing,
    isLoadingOlder,
    isPositioned,
}: {
    hasOlder: boolean;
    isFollowing: boolean;
    isLoadingOlder: boolean;
    isPositioned: boolean;
}): boolean => isPositioned && !isFollowing && hasOlder && !isLoadingOlder;

/**
 * Whether the list follows its end after a scroll event. Only the reader's own touch (a drag or the momentum after it)
 * may stop following: a programmatic scroll, or a scroll event reporting an offset taken before the list caught up with
 * new content, would otherwise read as the reader leaving the end. Any scroll that reaches the end resumes it.
 */
export const isConversationFollowingAfterScroll = ({
    isFollowing,
    isNearEnd,
    isTouching,
}: {
    isFollowing: boolean;
    isNearEnd: boolean;
    isTouching: boolean;
}): boolean => (isTouching ? isNearEnd : isFollowing || isNearEnd);

/**
 * Follows the list's end across content and viewport changes without fighting the reader's finger. A drag stops
 * following at once; while a drag or its momentum runs, content changes never scroll; when the touch settles near the
 * end after content changed under it, the list catches up once. A touch that changed nothing is left where it settled,
 * so releasing just above the end does not snap. Requests within one frame collapse into one scroll, so a burst of
 * streamed rows measuring in the same frame scrolls once.
 */
export const createConversationFollower = ({
    nextFrame,
    scrollToEnd: initialScrollToEnd,
}: {
    nextFrame: (run: () => void) => void;
    /**
     * Scrolls the list to its end. A list can also connect it later with `connect`, once its ref exists.
     */
    scrollToEnd?: () => void;
}) => {
    let scrollToEnd = initialScrollToEnd;
    let isFollowing = true;
    let isDragging = false;
    let isMomentum = false;
    /**
     * Whether a momentum may still begin from the reader's last drag. Android also reports an animated programmatic
     * scroll (Jump to latest) as momentum (`startFlingAnimator` in React Native's `ReactScrollView`), and that one must
     * not read as the reader leaving the end.
     */
    let canCoast = false;
    let isScheduled = false;
    let hasMissedChange = false;
    const isTouching = (): boolean => isDragging || isMomentum;
    const request = (): void => {
        if (isTouching()) {
            hasMissedChange = true;
            return;
        }
        if (!isFollowing || isScheduled) return;
        isScheduled = true;
        nextFrame(() => {
            isScheduled = false;
            // A momentum that began after the request defers the scroll to when the touch settles.
            if (isTouching()) hasMissedChange = true;
            else if (isFollowing) scrollToEnd?.();
        });
    };
    const settle = (): void => {
        if (!hasMissedChange || isTouching()) return;
        hasMissedChange = false;
        request();
    };
    return {
        /**
         * Connects the scroll once the list's ref exists; the returned function disconnects it on unmount.
         */
        connect: (scroll: () => void): (() => void) => {
            scrollToEnd = scroll;
            return () => {
                if (scrollToEnd === scroll) scrollToEnd = undefined;
            };
        },
        get isFollowing(): boolean {
            return isFollowing;
        },
        get isTouching(): boolean {
            return isTouching();
        },
        beginDrag: (): void => {
            isDragging = true;
            isFollowing = false;
        },
        endDrag: (): void => {
            isDragging = false;
            canCoast = true;
            settle();
        },
        beginMomentum: (): void => {
            isMomentum = canCoast;
            canCoast = false;
        },
        endMomentum: (): void => {
            isMomentum = false;
            settle();
        },
        /**
         * Records where a scroll event left the list; returns whether it now follows.
         */
        recordScroll: (isNearEnd: boolean): boolean => {
            isFollowing = isConversationFollowingAfterScroll({
                isFollowing,
                isNearEnd,
                isTouching: isTouching(),
            });
            return isFollowing;
        },
        /**
         * Follows again from wherever the reader was, as after the user's own send or Jump to latest.
         */
        follow: (): void => {
            isFollowing = true;
            canCoast = false;
        },
        /**
         * The content or viewport changed; scroll to the end on the next frame if the list still follows then.
         */
        request,
    };
};

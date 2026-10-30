import { describe, expect, it } from 'vitest';

import {
    CONVERSATION_TURN_TOP_GAP,
    conversationEndOffset,
    conversationTurnSpacerHeight,
    createConversationFollower,
    isConversationFollowingAfterScroll,
    latestConversationTurnStart,
    shouldFillConversationWithOlder,
    shouldReadOlderAtConversationTop,
} from '../conversation-scroll';

describe('latestConversationTurnStart', () => {
    const entries = [{ user: true }, { user: false }, { user: true }, { user: false }];

    it('finds the newest row that starts a turn', () => {
        expect(latestConversationTurnStart(entries, (entry) => entry.user)).toBe(2);
    });

    it('reports none without turns or without a marker', () => {
        expect(latestConversationTurnStart(entries, () => false)).toBe(-1);
        expect(latestConversationTurnStart(entries, undefined)).toBe(-1);
    });
});

describe('conversationTurnSpacerHeight', () => {
    it('leaves room for a short turn to rest below the top gap', () => {
        expect(
            conversationTurnSpacerHeight({
                bottomInset: 8,
                contentHeight: 1_000,
                turnTop: 900,
                viewportHeight: 600,
            }),
        ).toBe(600 - 100 - CONVERSATION_TURN_TOP_GAP - 8);
    });

    it('is gone once the turn outgrows the viewport', () => {
        expect(
            conversationTurnSpacerHeight({
                contentHeight: 2_000,
                turnTop: 1_200,
                viewportHeight: 600,
            }),
        ).toBe(0);
    });

    it('rounds to whole points so re-measuring the same layout settles', () => {
        expect(
            conversationTurnSpacerHeight({
                contentHeight: 100.4,
                turnTop: 0,
                topGap: 0,
                viewportHeight: 300,
            }),
        ).toBe(200);
    });
});

describe('conversationEndOffset', () => {
    const viewportHeight = 600;
    const bottomInset = 12;
    const firstItemOffset = 40;
    const turnTop = 900;
    const endFor = (contentHeight: number): number => {
        const spacerHeight = conversationTurnSpacerHeight({
            bottomInset,
            contentHeight,
            turnTop,
            viewportHeight,
        });
        return conversationEndOffset({
            bottomInset,
            contentHeight,
            firstItemOffset,
            spacerHeight,
            viewportHeight,
        });
    };

    it('rests the latest turn at the top while the spacer absorbs a growing reply', () => {
        const restingEnd = firstItemOffset + turnTop - CONVERSATION_TURN_TOP_GAP;
        expect(endFor(1000)).toBe(restingEnd);
        expect(endFor(1020)).toBe(restingEnd);
        expect(endFor(1300)).toBe(restingEnd);
    });

    it('follows the rows once the turn outgrows the viewport', () => {
        expect(endFor(2000)).toBe(firstItemOffset + 2000 + bottomInset - viewportHeight);
        expect(endFor(2020) - endFor(2000)).toBe(20);
    });

    it('lifts the first turn of a short Conversation to the top past the bottom-anchored margin', () => {
        // One turn of 200 rows' height under a 40 header: FlashList's margin ends the rows at the viewport's bottom.
        const spacerHeight = conversationTurnSpacerHeight({
            bottomInset,
            contentHeight: 200,
            turnTop: 0,
            viewportHeight,
        });
        const end = conversationEndOffset({
            bottomInset,
            contentHeight: 200,
            firstItemOffset,
            spacerHeight,
            viewportHeight,
        });
        const margin = viewportHeight - 200 - firstItemOffset;
        expect(firstItemOffset + margin - end).toBe(CONVERSATION_TURN_TOP_GAP);
    });

    it('never scrolls a short list without a spacer', () => {
        expect(
            conversationEndOffset({
                contentHeight: 200,
                firstItemOffset: 0,
                spacerHeight: 0,
                viewportHeight,
            }),
        ).toBe(0);
    });
});

describe('shouldFillConversationWithOlder', () => {
    const base = {
        contentHeight: 300,
        hasOlder: true,
        isLoadingOlder: false,
        isPositioned: true,
        viewportHeight: 700,
    };

    it('reads an older page while the rows leave the viewport partly blank', () => {
        expect(shouldFillConversationWithOlder(base)).toBe(true);
    });

    it('stops once the rows fill the viewport, nothing older remains, or a page is on its way', () => {
        expect(shouldFillConversationWithOlder({ ...base, contentHeight: 700 })).toBe(false);
        expect(shouldFillConversationWithOlder({ ...base, hasOlder: false })).toBe(false);
        expect(shouldFillConversationWithOlder({ ...base, isLoadingOlder: true })).toBe(false);
    });

    it('waits for the first positioning and a measured viewport', () => {
        expect(shouldFillConversationWithOlder({ ...base, isPositioned: false })).toBe(false);
        expect(shouldFillConversationWithOlder({ ...base, viewportHeight: 0 })).toBe(false);
    });
});

describe('shouldReadOlderAtConversationTop', () => {
    const base = { hasOlder: true, isFollowing: false, isLoadingOlder: false, isPositioned: true };

    it('reads an older page once the reader has scrolled back to the top', () => {
        expect(shouldReadOlderAtConversationTop(base)).toBe(true);
    });

    it('leaves a short list that follows its end to the one-page fill', () => {
        expect(shouldReadOlderAtConversationTop({ ...base, isFollowing: true })).toBe(false);
    });

    it('waits for positioning, more history, and the page already on its way', () => {
        expect(shouldReadOlderAtConversationTop({ ...base, isPositioned: false })).toBe(false);
        expect(shouldReadOlderAtConversationTop({ ...base, hasOlder: false })).toBe(false);
        expect(shouldReadOlderAtConversationTop({ ...base, isLoadingOlder: true })).toBe(false);
    });
});

describe('isConversationFollowingAfterScroll', () => {
    it('lets only the reader stop following', () => {
        expect(
            isConversationFollowingAfterScroll({
                isFollowing: true,
                isNearEnd: false,
                isTouching: true,
            }),
        ).toBe(false);
        expect(
            isConversationFollowingAfterScroll({
                isFollowing: true,
                isNearEnd: false,
                isTouching: false,
            }),
        ).toBe(true);
    });

    it('resumes whenever a scroll reaches the end', () => {
        expect(
            isConversationFollowingAfterScroll({
                isFollowing: false,
                isNearEnd: true,
                isTouching: false,
            }),
        ).toBe(true);
        expect(
            isConversationFollowingAfterScroll({
                isFollowing: false,
                isNearEnd: true,
                isTouching: true,
            }),
        ).toBe(true);
        expect(
            isConversationFollowingAfterScroll({
                isFollowing: false,
                isNearEnd: false,
                isTouching: false,
            }),
        ).toBe(false);
    });
});

describe('createConversationFollower', () => {
    const setup = () => {
        const frames: Array<() => void> = [];
        let scrolls = 0;
        const follower = createConversationFollower({
            nextFrame: (run) => frames.push(run),
            scrollToEnd: () => {
                scrolls += 1;
            },
        });
        const flush = (): void => {
            const due = [...frames];
            frames.length = 0;
            for (const run of due) run();
        };
        return { follower, flush, scrolls: () => scrolls };
    };

    it('coalesces content changes in one frame into one scroll', () => {
        const { follower, flush, scrolls } = setup();
        follower.request();
        follower.request();
        follower.request();
        flush();
        expect(scrolls()).toBe(1);
    });

    it('stops following at drag start and never scrolls under the finger', () => {
        const { follower, flush, scrolls } = setup();
        follower.beginDrag();
        expect(follower.isFollowing).toBe(false);
        follower.recordScroll(true);
        follower.request();
        flush();
        expect(scrolls()).toBe(0);
    });

    it('catches up once when a touch settles near the end after content changed', () => {
        const { follower, flush, scrolls } = setup();
        follower.beginDrag();
        follower.recordScroll(true);
        follower.request();
        follower.endDrag();
        follower.beginMomentum();
        flush();
        expect(scrolls()).toBe(0);
        follower.endMomentum();
        flush();
        expect(scrolls()).toBe(1);
    });

    it('leaves a settled touch alone when nothing changed under it', () => {
        const { follower, flush, scrolls } = setup();
        follower.beginDrag();
        follower.recordScroll(true);
        follower.endDrag();
        flush();
        expect(scrolls()).toBe(0);
    });

    it('stays put after the reader scrolls away, and follows again on request', () => {
        const { follower, flush, scrolls } = setup();
        follower.beginDrag();
        follower.recordScroll(false);
        follower.endDrag();
        follower.request();
        flush();
        expect(scrolls()).toBe(0);
        follower.follow();
        follower.request();
        flush();
        expect(scrolls()).toBe(1);
    });

    it('keeps following through an animated jump that Android reports as momentum', () => {
        const { follower, flush, scrolls } = setup();
        follower.beginDrag();
        follower.recordScroll(false);
        follower.endDrag();
        follower.follow();
        follower.beginMomentum();
        expect(follower.recordScroll(false)).toBe(true);
        follower.request();
        flush();
        expect(scrolls()).toBe(1);
        follower.endMomentum();
        expect(follower.isFollowing).toBe(true);
    });

    it('ignores a programmatic scroll event that lags behind new content', () => {
        const { follower } = setup();
        expect(follower.recordScroll(false)).toBe(true);
    });
});

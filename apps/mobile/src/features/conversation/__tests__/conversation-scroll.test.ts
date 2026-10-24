import { describe, expect, it } from 'vitest';

import {
    CONVERSATION_TURN_TOP_GAP,
    conversationTurnSpacerHeight,
    createConversationFollower,
    isConversationFollowingAfterScroll,
    latestConversationTurnStart,
    shouldFillConversationWithOlder,
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

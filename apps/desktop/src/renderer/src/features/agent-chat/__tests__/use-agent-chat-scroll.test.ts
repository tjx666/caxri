import { describe, expect, it } from 'vitest';

import {
    AGENT_CHAT_FOLLOW_THRESHOLD_PX,
    agentChatAnchoredScrollTop,
    agentChatFollowScrollTop,
    agentChatTurnSpacerHeight,
    isLatestInView,
    isScrolledToEnd,
} from '../hooks/use-agent-chat-scroll';

describe('isScrolledToEnd', () => {
    it('follows while the view is within the threshold of the end', () => {
        expect(isScrolledToEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(
            true,
        );
        expect(
            isScrolledToEnd({
                scrollHeight: 1000,
                scrollTop: 600 - AGENT_CHAT_FOLLOW_THRESHOLD_PX,
                clientHeight: 400,
            }),
        ).toBe(true);
    });

    it('stops following once the user scrolled up past the threshold', () => {
        expect(isScrolledToEnd({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(
            false,
        );
    });
});

describe('isLatestInView', () => {
    it('counts the latest entry in view while its end is on screen, whatever space is kept below it', () => {
        expect(isLatestInView({ contentBottom: 400, viewHeight: 800 })).toBe(true);
        expect(
            isLatestInView({
                contentBottom: 800 + AGENT_CHAT_FOLLOW_THRESHOLD_PX,
                viewHeight: 800,
            }),
        ).toBe(true);
    });

    it('reports the latest entry out of view once its end is below the view', () => {
        expect(
            isLatestInView({
                contentBottom: 801 + AGENT_CHAT_FOLLOW_THRESHOLD_PX,
                viewHeight: 800,
            }),
        ).toBe(false);
    });
});

describe('agentChatFollowScrollTop', () => {
    it('keeps the end in view when a dock shrinks the view while following', () => {
        // At the end of a 1000px timeline in a 400px view, a dock grows and the view shrinks to 300px.
        expect(agentChatFollowScrollTop({ scrollHeight: 1000, clientHeight: 400 }, true)).toBe(600);
        expect(agentChatFollowScrollTop({ scrollHeight: 1000, clientHeight: 300 }, true)).toBe(700);
    });

    it('leaves the view alone while the user reads history, and never goes above the top', () => {
        expect(
            agentChatFollowScrollTop({ scrollHeight: 1000, clientHeight: 300 }, false),
        ).toBeNull();
        expect(agentChatFollowScrollTop({ scrollHeight: 200, clientHeight: 300 }, true)).toBe(0);
    });
});

describe('agentChatAnchoredScrollTop', () => {
    it('keeps a clicked row in place when the content above or around it changes height', () => {
        // The row sat 300px below the view's top; expanding it pushed it to 420px, so the view scrolls by 120px.
        expect(agentChatAnchoredScrollTop(500, 300, 420)).toBe(620);
        // Collapsing pulled it up to 260px.
        expect(agentChatAnchoredScrollTop(500, 300, 260)).toBe(460);
    });

    it('never scrolls above the top', () => {
        expect(agentChatAnchoredScrollTop(10, 300, 100)).toBe(0);
    });
});

describe('agentChatTurnSpacerHeight', () => {
    it('leaves room for the latest turn to rest at the top of the view', () => {
        expect(agentChatTurnSpacerHeight(800, 120)).toBe(568);
        expect(agentChatTurnSpacerHeight(800, 120, 0)).toBe(680);
    });

    it('needs no room once the turn fills the view', () => {
        expect(agentChatTurnSpacerHeight(800, 688)).toBe(0);
        expect(agentChatTurnSpacerHeight(800, 2000)).toBe(0);
    });
});

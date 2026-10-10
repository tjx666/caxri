import { describe, expect, it } from 'vitest';

import {
    AGENT_CHAT_FOLLOW_THRESHOLD_PX,
    agentChatFollowScrollTop,
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

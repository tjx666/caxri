import { describe, expect, it } from 'vitest';

import { AGENT_CHAT_FOLLOW_THRESHOLD_PX, isScrolledToEnd } from '../use-agent-chat-scroll';

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

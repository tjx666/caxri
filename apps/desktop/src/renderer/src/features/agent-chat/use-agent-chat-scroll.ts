import type { RefObject } from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';

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
 * Keeps the timeline pinned to its end while the user is reading the end, and leaves it alone once they scroll up to
 * read history. `revision` changes with every streamed patch, so following is re-applied after each layout.
 */
export function useAgentChatScroll(revision: number | undefined): {
    scrollReference: RefObject<HTMLDivElement | null>;
    onScroll: () => void;
} {
    const scrollReference = useRef<HTMLDivElement | null>(null);
    const isFollowing = useRef(true);
    const onScroll = useCallback(() => {
        const element = scrollReference.current;
        if (element) isFollowing.current = isScrolledToEnd(element);
    }, []);
    useLayoutEffect(() => {
        const element = scrollReference.current;
        if (element && isFollowing.current) element.scrollTop = element.scrollHeight;
    }, [revision]);
    return { scrollReference, onScroll };
}

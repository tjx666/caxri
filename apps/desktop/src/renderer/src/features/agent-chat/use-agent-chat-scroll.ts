import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

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
 * read history. `revision` changes with every streamed patch, so following is re-applied after each layout; a resize of
 * the content (an expanded tool row, a narrower pane re-wrapping text) moves the end without a new revision, so the
 * content is observed too. `isFollowing` drives the "Jump to latest" control shown while reading history.
 */
export function useAgentChatScroll(revision: number | undefined): {
    scrollReference: RefObject<HTMLDivElement | null>;
    contentReference: RefObject<HTMLDivElement | null>;
    isFollowing: boolean;
    onScroll: () => void;
    jumpToLatest: () => void;
} {
    const scrollReference = useRef<HTMLDivElement | null>(null);
    const contentReference = useRef<HTMLDivElement | null>(null);
    const isFollowingReference = useRef(true);
    const [isFollowing, setFollowing] = useState(true);
    const pin = useCallback(() => {
        const element = scrollReference.current;
        if (element && isFollowingReference.current) element.scrollTop = element.scrollHeight;
    }, []);
    const onScroll = useCallback(() => {
        const element = scrollReference.current;
        if (!element) return;
        isFollowingReference.current = isScrolledToEnd(element);
        setFollowing(isFollowingReference.current);
    }, []);
    const jumpToLatest = useCallback(() => {
        isFollowingReference.current = true;
        setFollowing(true);
        pin();
    }, [pin]);
    useLayoutEffect(pin, [pin, revision]);
    useEffect(() => {
        const content = contentReference.current;
        if (!content) return;
        const observer = new ResizeObserver(pin);
        observer.observe(content);
        return () => observer.disconnect();
    }, [pin]);
    return { scrollReference, contentReference, isFollowing, onScroll, jumpToLatest };
}

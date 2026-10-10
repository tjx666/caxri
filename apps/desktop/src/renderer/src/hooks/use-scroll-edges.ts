import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

/**
 * Which edges of a scroll container currently hide content, so a caller can fade in a cue only on the side that
 * actually has more to reveal. `start`/`end` are left/right for a horizontal scroller and top/bottom for a vertical
 * one.
 */
export interface ScrollEdges {
    canScrollStart: boolean;
    canScrollEnd: boolean;
}

const NO_SCROLL_EDGES: ScrollEdges = { canScrollStart: false, canScrollEnd: false };

/**
 * One update from watching a start/end sentinel's visibility inside the scroll container: the sentinel not intersecting
 * means content has scrolled past it, i.e. there is more to scroll to on that side.
 */
export interface ScrollEdgeIntersection {
    edge: 'start' | 'end';
    isIntersecting: boolean;
}

/**
 * Pure reducer over sentinel intersection updates, kept separate from the `IntersectionObserver`-driven hook below so
 * this is unit-testable without a browser (repo convention: extract logic out of the component/hook to test it).
 */
export function applyScrollEdgeIntersections(
    previous: ScrollEdges,
    intersections: readonly ScrollEdgeIntersection[],
): ScrollEdges {
    return intersections.reduce<ScrollEdges>((edges, { edge, isIntersecting }) => {
        const canScroll = !isIntersecting;
        if (edge === 'start')
            return canScroll === edges.canScrollStart
                ? edges
                : { ...edges, canScrollStart: canScroll };
        return canScroll === edges.canScrollEnd ? edges : { ...edges, canScrollEnd: canScroll };
    }, previous);
}

/**
 * Tracks which edges of a scroll container a caller should fade, so a list can show "there is more to scroll to"
 * (`PaneTabBar`'s tab strip, an Agent Chat work group): `overflow-*-auto` alone gives no such cue.
 *
 * Watches two zero-footprint sentinel elements the caller renders at the very start and end of the scrollable content
 * (`startReference`/`endReference`) against the scroll container itself as the `IntersectionObserver` root, rather than
 * reading `scrollLeft`/`scrollWidth` off a `scroll` listener: a sentinel's visibility already answers "is there more
 * content past this edge" without a layout read on every scroll event, and the same observer entries fire for a tab
 * opening or closing or a row being added (which moves the end sentinel) with no separate `ResizeObserver`.
 */
export function useScrollEdges(
    scrollReference: RefObject<HTMLElement | null>,
    startReference: RefObject<HTMLElement | null>,
    endReference: RefObject<HTMLElement | null>,
): ScrollEdges {
    const [edges, setEdges] = useState<ScrollEdges>(NO_SCROLL_EDGES);
    useEffect(() => {
        const root = scrollReference.current;
        const start = startReference.current;
        const end = endReference.current;
        if (!root || !start || !end) return;
        const observer = new IntersectionObserver(
            (entries) => {
                const intersections: ScrollEdgeIntersection[] = entries.map((entry) => ({
                    edge: entry.target === start ? 'start' : 'end',
                    isIntersecting: entry.isIntersecting,
                }));
                setEdges((previous) => applyScrollEdgeIntersections(previous, intersections));
            },
            { root, threshold: 0 },
        );
        observer.observe(start);
        observer.observe(end);
        return () => observer.disconnect();
    }, [scrollReference, startReference, endReference]);
    return edges;
}

/**
 * Keeps the Activity chart pinned to its newest weeks. The chart runs oldest to newest, so a pane narrower than the
 * year should show the right edge; that has to hold not only on mount but whenever the pane narrows later (an editor
 * group split or a resized sidebar), or the chart is left at the oldest months.
 */

/**
 * Sub-pixel slack: fractional layout widths can leave `scrollLeft` a fraction short of the true end.
 */
const END_TOLERANCE_PX = 1;

export interface ScrollMetrics {
    scrollLeft: number;
    clientWidth: number;
    scrollWidth: number;
}

/**
 * True when the horizontal scroller shows its right edge, including when it does not overflow at all.
 */
export function isScrolledToEnd({ scrollLeft, clientWidth, scrollWidth }: ScrollMetrics): boolean {
    return scrollLeft + clientWidth >= scrollWidth - END_TOLERANCE_PX;
}

export interface EndPinTarget extends ScrollMetrics {
    addEventListener(type: 'scroll', listener: () => void): void;
    removeEventListener(type: 'scroll', listener: () => void): void;
}

export interface EndPin {
    /**
     * Scrolls to the end and pins again, for a fresh layout such as a view switch.
     */
    repin(): void;
    dispose(): void;
}

type ObserverFactory = (callback: () => void) => {
    observe(target: never): void;
    disconnect(): void;
};

/**
 * Pins `element` to its scroll end now and after every size change, but only while the user has not scrolled away from
 * the end: a user reading older months keeps their position. The pin flag is sampled on `scroll`, not at resize time,
 * because narrowing the scroller moves the end away without firing `scroll`, which is exactly the case to re-pin.
 */
export function attachEndPin(
    element: EndPinTarget,
    createObserver: ObserverFactory = (callback) => new ResizeObserver(callback),
): EndPin {
    let isPinned = true;
    const scrollToEnd = () => {
        element.scrollLeft = element.scrollWidth;
    };
    const onScroll = () => {
        isPinned = isScrolledToEnd(element);
    };
    const observer = createObserver(() => {
        if (isPinned) scrollToEnd();
    });
    element.addEventListener('scroll', onScroll);
    observer.observe(element as never);
    scrollToEnd();
    return {
        repin() {
            isPinned = true;
            scrollToEnd();
        },
        dispose() {
            element.removeEventListener('scroll', onScroll);
            observer.disconnect();
        },
    };
}

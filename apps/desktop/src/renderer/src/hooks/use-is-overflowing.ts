import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

/**
 * Whether an element's content is wider than the box that renders it, i.e. whether CSS actually clipped it.
 *
 * A label styled with `text-ellipsis` gives no signal of its own that anything was cut off, so a caller that wants to
 * reveal the full text (a tooltip) can only tell by measuring. `scrollWidth`/`clientWidth` are both layout-rounded to
 * whole pixels, which is what keeps a sub-pixel flex width from reporting a permanent one-pixel overflow.
 *
 * Re-measuring cannot ride on `ResizeObserver` alone, which is why `content` is a parameter rather than something the
 * hook reads off the element: replacing the text inside a fixed-width box changes `scrollWidth` without changing the
 * observed box, so the observer never fires.
 *
 * @param reference Element to measure; measurement is skipped while it is unmounted.
 * @param content The rendered text.
 */
export function useIsOverflowing(
    reference: RefObject<HTMLElement | null>,
    content: string,
): boolean {
    const [isOverflowing, setIsOverflowing] = useState(false);
    useEffect(() => {
        const element = reference.current;
        if (!element) return;
        const measure = (): void => setIsOverflowing(element.scrollWidth > element.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [content, reference]);
    return isOverflowing;
}

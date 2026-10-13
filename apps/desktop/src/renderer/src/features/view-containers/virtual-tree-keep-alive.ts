import type { Rect, Virtualizer } from '@tanstack/react-virtual';
import { measureElement, observeElementRect } from '@tanstack/react-virtual';

/**
 * Drops the zero-height viewport a keep-alive container reports while it is hidden (`display: none`).
 *
 * TanStack Virtual treats a zero `outerSize` as "nothing visible" and returns no virtual items, so a hidden Files or
 * Git tree unmounted every row and remounted them all when the container was shown again. Keeping the last shown
 * viewport leaves the rows mounted; a real resize after the container is shown still reports through.
 */
export function ignoreHiddenViewportRect(callback: (rect: Rect) => void): (rect: Rect) => void {
    return (rect) => {
        if (rect.height === 0) return;
        callback(rect);
    };
}

/**
 * `observeElementRect` for a virtualized tree inside a keep-alive view container. See {@link ignoreHiddenViewportRect}.
 */
export function observeKeepAliveElementRect<TScrollElement extends Element>(
    instance: Virtualizer<TScrollElement, Element>,
    callback: (rect: Rect) => void,
): ReturnType<typeof observeElementRect> {
    return observeElementRect(instance, ignoreHiddenViewportRect(callback));
}

/**
 * A row measured as zero while its container is hidden keeps its previous size. Without this, every measured row
 * collapsed to zero on hide and the tree re-laid out twice (on hide and on reveal) for nothing on screen.
 */
export function keepAliveMeasuredSize(measured: number, previous: number | undefined): number {
    return measured === 0 && previous !== undefined ? previous : measured;
}

/**
 * `measureElement` for a virtualized tree inside a keep-alive view container. See {@link keepAliveMeasuredSize}.
 */
export function measureKeepAliveElement<TScrollElement extends Element>(
    element: Element,
    entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<TScrollElement, Element>,
): number {
    const measured = measureElement(element, entry, instance);
    if (measured !== 0) return measured;
    const key = instance.options.getItemKey(instance.indexFromElement(element));
    return keepAliveMeasuredSize(measured, instance.itemSizeCache.get(key));
}

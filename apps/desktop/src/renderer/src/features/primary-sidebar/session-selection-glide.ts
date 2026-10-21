/**
 * A row's box inside the scrolling list, in the list's content coordinates, so it stays valid however far the list has
 * scrolled.
 */
export interface GlideBox {
    height: number;
    left: number;
    top: number;
    width: number;
}

/**
 * `element`'s box in `list`'s content coordinates.
 */
export function glideBoxIn(list: HTMLElement, element: Element): GlideBox {
    const listRect = list.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
        height: rect.height,
        left: rect.left - listRect.left + list.scrollLeft,
        top: rect.top - listRect.top + list.scrollTop,
        width: rect.width,
    };
}

/**
 * The keyframes that carry the selection fill from `from` to `to`. The fill is laid out at `to`, so only the start
 * frame is offset: an interrupted glide that restarts from where the fill is on screen lands in the same place.
 */
export function selectionGlideKeyframes(from: GlideBox, to: GlideBox): Keyframe[] {
    return [
        {
            height: `${from.height}px`,
            transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`,
            width: `${from.width}px`,
        },
        { height: `${to.height}px`, transform: 'translate(0px, 0px)', width: `${to.width}px` },
    ];
}

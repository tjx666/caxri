/**
 * Frames still pending before a scroller gets its scrollbar back, so a second quiet scroll in the meantime restarts the
 * wait instead of letting the first one reveal the scrollbar mid-jump.
 */
const pendingRestores = new WeakMap<HTMLElement, { frame: number; scrollbarWidth: string }>();

/**
 * Whether the scroller's scrollbar takes layout space: a classic always-visible scrollbar rather than a macOS overlay.
 */
function hasLayoutScrollbar(element: HTMLElement): boolean {
    const style = getComputedStyle(element);
    const borders = pixels(style.borderLeftWidth) + pixels(style.borderRightWidth);
    return element.offsetWidth > element.clientWidth + borders;
}

function pixels(length: string): number {
    // eslint-disable-next-line unicorn/prefer-number-coercion -- a computed length carries a "px" suffix, which `Number()` cannot parse
    return Number.parseFloat(length);
}

/**
 * Moves a scroller to `top` without flashing its overlay scrollbar.
 *
 * Chromium on macOS reveals an overlay scrollbar on every change of scroll offset, a programmatic one included, and
 * keeps it on screen for about half a second; even a scroller that is created and positioned before its first paint
 * flashes. To the user that reads as the view scrolling by itself. Hiding the scrollbar (`scrollbar-width: none`) for
 * the frame that commits the new offset suppresses the reveal, and bringing it back afterwards does not trigger one,
 * because a scrollbar that appears without a scroll stays faded out until the user scrolls.
 *
 * A classic always-visible scrollbar takes layout space, so hiding it would reflow the content for those frames; that
 * scroller is moved plainly.
 */
export function scrollWithoutScrollbarFlash(element: HTMLElement, top: number): void {
    const pending = pendingRestores.get(element);
    if (!pending && hasLayoutScrollbar(element)) {
        element.scrollTop = top;
        return;
    }
    if (pending) cancelAnimationFrame(pending.frame);
    const scrollbarWidth = pending?.scrollbarWidth ?? element.style.scrollbarWidth;
    element.style.scrollbarWidth = 'none';
    element.scrollTop = top;
    // The new offset reaches the compositor with the next frame; the scrollbar comes back on the one after.
    const frame = requestAnimationFrame(() => {
        pendingRestores.set(element, {
            frame: requestAnimationFrame(() => {
                pendingRestores.delete(element);
                element.style.scrollbarWidth = scrollbarWidth;
            }),
            scrollbarWidth,
        });
    });
    pendingRestores.set(element, { frame, scrollbarWidth });
}

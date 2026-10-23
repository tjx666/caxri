/**
 * Frames still pending before a scroller gets its scrollbar back, so a second quiet scroll in the meantime restarts the
 * wait instead of letting the first one reveal the scrollbar mid-jump.
 */
const pendingRestores = new WeakMap<HTMLElement, { frame: number; scrollbarWidth: string }>();

/**
 * How long a settling scroller must go without moving or resizing before its scrollbar comes back.
 */
const SETTLE_QUIET_MS = 300;

/**
 * The longest a scroller keeps its scrollbar hidden while settling, so content that keeps growing (a reply still
 * streaming) does not hide it for good.
 */
const SETTLE_MAX_MS = 2000;

/**
 * Input that starts a scroll by the user: from then on the scrollbar shows the motion as usual.
 */
const USER_SCROLL_EVENTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;

const settlingScrollers = new WeakMap<
    HTMLElement,
    {
        deadline: number;
        release: () => void;
        scrollbarWidth: string;
        timer?: ReturnType<typeof setTimeout>;
    }
>();

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
    if (settlingScrollers.has(element)) {
        // The settling hold already keeps the scrollbar hidden and brings it back itself.
        element.scrollTop = top;
        return;
    }
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

/**
 * Whether {@link hideScrollbarWhileSettling} still holds the scroller's scrollbar hidden.
 */
export function isScrollbarSettling(element: HTMLElement): boolean {
    return settlingScrollers.has(element);
}

/**
 * Keeps a scroller's overlay scrollbar hidden while the content it just opened onto settles, then brings it back.
 *
 * A view opened at its end is not done moving after its first jump: rows finish laying out a few frames later (a font
 * or highlighted code arriving grows a reply by a pixel or two), and the view either follows the new end or Chromium's
 * scroll anchoring moves it. Neither is the user scrolling, yet each reveals the scrollbar like any other change of
 * offset (see {@link scrollWithoutScrollbarFlash}). Call this after the first jump and again on every scroll or layout
 * change while {@link isScrollbarSettling}: the scrollbar comes back once the scroller has gone `SETTLE_QUIET_MS`
 * without either, after `SETTLE_MAX_MS` at most, or at once when the user starts scrolling.
 */
export function hideScrollbarWhileSettling(element: HTMLElement): void {
    const now = Date.now();
    let settling = settlingScrollers.get(element);
    if (!settling) {
        const pending = pendingRestores.get(element);
        if (!pending && hasLayoutScrollbar(element)) return;
        if (pending) {
            cancelAnimationFrame(pending.frame);
            pendingRestores.delete(element);
        }
        const release = (): void => {
            const current = settlingScrollers.get(element);
            if (!current) return;
            settlingScrollers.delete(element);
            clearTimeout(current.timer);
            for (const type of USER_SCROLL_EVENTS) element.removeEventListener(type, release);
            element.style.scrollbarWidth = current.scrollbarWidth;
        };
        settling = {
            deadline: now + SETTLE_MAX_MS,
            release,
            scrollbarWidth: pending?.scrollbarWidth ?? element.style.scrollbarWidth,
        };
        settlingScrollers.set(element, settling);
        element.style.scrollbarWidth = 'none';
        for (const type of USER_SCROLL_EVENTS)
            element.addEventListener(type, release, { once: true, passive: true });
    }
    clearTimeout(settling.timer);
    settling.timer = setTimeout(
        settling.release,
        Math.min(SETTLE_QUIET_MS, settling.deadline - now),
    );
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    hideScrollbarWhileSettling,
    isScrollbarSettling,
    scrollWithoutScrollbarFlash,
} from './quiet-scroll';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`). `scrollWithoutScrollbarFlash`
 * touches the element's box sizes, inline style, and scroll offset, plus `getComputedStyle` and the animation-frame
 * queue, so those are stubbed and frames are run by hand.
 */
const frames = new Map<number, FrameRequestCallback>();
const frameIds = { next: 1 };

function runFrame(): void {
    const pending = frames.values().toArray();
    frames.clear();
    for (const callback of pending) callback(0);
}

function scroller({ scrollbarWidth = 0, inlineScrollbarWidth = '' } = {}) {
    const listeners = new Map<string, () => void>();
    return {
        listeners,
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
        offsetWidth: 400,
        clientWidth: 400 - scrollbarWidth,
        scrollTop: 0,
        style: { scrollbarWidth: inlineScrollbarWidth },
    } as unknown as HTMLElement & { listeners: Map<string, () => void> };
}

beforeEach(() => {
    frames.clear();
    frameIds.next = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = frameIds.next++;
        frames.set(id, callback);
        return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('getComputedStyle', () => ({ borderLeftWidth: '0px', borderRightWidth: '0px' }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('scrollWithoutScrollbarFlash', () => {
    it('hides an overlay scrollbar for the frame that commits the jump and brings it back on the next one', () => {
        const element = scroller();
        scrollWithoutScrollbarFlash(element, 1200);
        expect(element.scrollTop).toBe(1200);
        expect(element.style.scrollbarWidth).toBe('none');
        runFrame();
        expect(element.style.scrollbarWidth).toBe('none');
        runFrame();
        expect(element.style.scrollbarWidth).toBe('');
        expect(frames.size).toBe(0);
    });

    it('restarts the wait for a second jump and restores the style the scroller had before the first', () => {
        const element = scroller({ inlineScrollbarWidth: 'thin' });
        scrollWithoutScrollbarFlash(element, 600);
        runFrame();
        scrollWithoutScrollbarFlash(element, 1800);
        expect(element.scrollTop).toBe(1800);
        runFrame();
        expect(element.style.scrollbarWidth).toBe('none');
        runFrame();
        expect(element.style.scrollbarWidth).toBe('thin');
        expect(frames.size).toBe(0);
    });

    it('moves a scroller with a classic scrollbar plainly, since hiding that one would reflow the content', () => {
        const element = scroller({ scrollbarWidth: 15 });
        scrollWithoutScrollbarFlash(element, 900);
        expect(element.scrollTop).toBe(900);
        expect(element.style.scrollbarWidth).toBe('');
        expect(frames.size).toBe(0);
    });
});

describe('hideScrollbarWhileSettling', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });

    it('keeps the scrollbar hidden past the jump while the opened view settles, then brings it back', () => {
        const element = scroller({ inlineScrollbarWidth: 'thin' });
        scrollWithoutScrollbarFlash(element, 1200);
        hideScrollbarWhileSettling(element);
        runFrame();
        runFrame();
        // A reply growing by a pixel moves the view a frame later, and the scrollbar must still be hidden then.
        expect(element.style.scrollbarWidth).toBe('none');
        vi.advanceTimersByTime(200);
        scrollWithoutScrollbarFlash(element, 1202);
        hideScrollbarWhileSettling(element);
        vi.advanceTimersByTime(200);
        expect(element.style.scrollbarWidth).toBe('none');
        vi.advanceTimersByTime(100);
        expect(element.style.scrollbarWidth).toBe('thin');
        expect(isScrollbarSettling(element)).toBe(false);
        expect(element.listeners.size).toBe(0);
    });

    it('brings the scrollbar back at once when the user starts scrolling', () => {
        const element = scroller();
        hideScrollbarWhileSettling(element);
        element.listeners.get('wheel')?.();
        expect(element.style.scrollbarWidth).toBe('');
        expect(isScrollbarSettling(element)).toBe(false);
    });

    it('stops hiding the scrollbar after a bounded time while the content keeps moving', () => {
        const element = scroller();
        hideScrollbarWhileSettling(element);
        for (let elapsed = 0; elapsed < 1900; elapsed += 100) {
            vi.advanceTimersByTime(100);
            hideScrollbarWhileSettling(element);
        }
        expect(element.style.scrollbarWidth).toBe('none');
        vi.advanceTimersByTime(100);
        expect(element.style.scrollbarWidth).toBe('');
    });

    it('leaves a classic scrollbar alone, since hiding it would reflow the content', () => {
        const element = scroller({ scrollbarWidth: 15 });
        hideScrollbarWhileSettling(element);
        expect(element.style.scrollbarWidth).toBe('');
        expect(isScrollbarSettling(element)).toBe(false);
    });
});

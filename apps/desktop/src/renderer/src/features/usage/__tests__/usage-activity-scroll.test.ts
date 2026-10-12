import { describe, expect, it } from 'vitest';

import type { EndPinTarget } from '../usage-activity-scroll';
import { attachEndPin, isScrolledToEnd } from '../usage-activity-scroll';

function fakeScroller(clientWidth: number, scrollWidth: number) {
    const listeners = new Set<() => void>();
    let scrollLeft = 0;
    const element = {
        clientWidth,
        scrollWidth,
        get scrollLeft() {
            return scrollLeft;
        },
        set scrollLeft(value: number) {
            scrollLeft = Math.max(0, Math.min(value, element.scrollWidth - element.clientWidth));
        },
        addEventListener: (_type: 'scroll', listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: 'scroll', listener: () => void) => listeners.delete(listener),
    } satisfies EndPinTarget;
    let resize = () => {};
    const createObserver = (callback: () => void) => {
        resize = callback;
        return { observe: () => {}, disconnect: () => (resize = () => {}) };
    };
    return {
        element,
        createObserver,
        /**
         * User scroll: moves and fires `scroll`, as a browser does.
         */
        userScroll(left: number) {
            element.scrollLeft = left;
            for (const listener of listeners) listener();
        },
        /**
         * Pane resize: narrowing leaves `scrollLeft` alone and fires no `scroll`, only the observer.
         */
        setWidth(width: number) {
            element.clientWidth = width;
            resize();
        },
    };
}

describe('isScrolledToEnd', () => {
    it('treats a non-overflowing scroller as at the end', () => {
        expect(isScrolledToEnd({ scrollLeft: 0, clientWidth: 800, scrollWidth: 800 })).toBe(true);
    });

    it('tolerates a sub-pixel shortfall and rejects a real offset', () => {
        expect(isScrolledToEnd({ scrollLeft: 199.5, clientWidth: 600, scrollWidth: 800 })).toBe(
            true,
        );
        expect(isScrolledToEnd({ scrollLeft: 100, clientWidth: 600, scrollWidth: 800 })).toBe(
            false,
        );
    });
});

describe('attachEndPin', () => {
    it('re-pins to the newest weeks when the pane narrows after mount', () => {
        const scroller = fakeScroller(800, 800);
        attachEndPin(scroller.element, scroller.createObserver);
        expect(scroller.element.scrollLeft).toBe(0);

        scroller.setWidth(500);
        expect(scroller.element.scrollLeft).toBe(300);
    });

    it('keeps the position of a user who scrolled toward older months', () => {
        const scroller = fakeScroller(500, 800);
        attachEndPin(scroller.element, scroller.createObserver);
        expect(scroller.element.scrollLeft).toBe(300);

        scroller.userScroll(50);
        scroller.setWidth(400);
        expect(scroller.element.scrollLeft).toBe(50);

        scroller.userScroll(400);
        scroller.setWidth(300);
        expect(scroller.element.scrollLeft).toBe(500);
    });

    it('repin returns to the end after the user scrolled away', () => {
        const scroller = fakeScroller(500, 800);
        const pin = attachEndPin(scroller.element, scroller.createObserver);
        scroller.userScroll(0);
        pin.repin();
        expect(scroller.element.scrollLeft).toBe(300);
        scroller.setWidth(400);
        expect(scroller.element.scrollLeft).toBe(400);
    });

    it('stops following after dispose', () => {
        const scroller = fakeScroller(800, 800);
        const pin = attachEndPin(scroller.element, scroller.createObserver);
        pin.dispose();
        scroller.setWidth(500);
        expect(scroller.element.scrollLeft).toBe(0);
    });
});

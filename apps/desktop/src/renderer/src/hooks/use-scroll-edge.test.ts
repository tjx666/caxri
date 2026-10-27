import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindScrollEdge } from './use-scroll-edge';

function createScroller({
    scrollTop,
    clientHeight = 100,
    scrollHeight = 100,
}: {
    scrollTop: number;
    clientHeight?: number;
    scrollHeight?: number;
}): {
    emit: (type: string) => void;
    scroller: HTMLElement;
} {
    const listeners = new Map<string, Set<EventListener>>();
    const scroller = {
        scrollTop,
        clientHeight,
        scrollHeight,
        children: [],
        dataset: {} as DOMStringMap,
        addEventListener(type: string, listener: EventListener) {
            const registered = listeners.get(type) ?? new Set<EventListener>();
            registered.add(listener);
            listeners.set(type, registered);
        },
        removeEventListener(type: string, listener: EventListener) {
            listeners.get(type)?.delete(listener);
        },
    } as unknown as HTMLElement;
    return {
        scroller,
        emit(type: string) {
            const registered = listeners.get(type) ?? new Set<EventListener>();
            for (const listener of registered) listener(new Event(type));
        },
    };
}

/**
 * The Renderer's tests run under Node, so the size and child-list observers are fakes the test fires by hand.
 */
const observed = { resize: () => {} };
beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe = vi.fn();
            disconnect = vi.fn();

            constructor(callback: () => void) {
                observed.resize = callback;
            }
        },
    );
    vi.stubGlobal(
        'MutationObserver',
        class {
            observe = vi.fn();
            disconnect = vi.fn();
        },
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('bindScrollEdge', () => {
    it('publishes false before any scroll when the list is at the top', () => {
        const { scroller } = createScroller({ scrollTop: 0 });
        const stop = bindScrollEdge(scroller);
        expect(scroller.dataset.scrolled).toBe('false');
        stop();
    });

    it('publishes true while scrollTop is past the start edge, then false when it returns', () => {
        const { emit, scroller } = createScroller({ scrollTop: 0 });
        const stop = bindScrollEdge(scroller);
        scroller.scrollTop = 24;
        emit('scroll');
        expect(scroller.dataset.scrolled).toBe('true');
        scroller.scrollTop = 0;
        emit('scroll');
        expect(scroller.dataset.scrolled).toBe('false');
        stop();
    });

    it('publishes more-below while rows remain past the end, and clears it at the end', () => {
        const { emit, scroller } = createScroller({
            scrollTop: 0,
            clientHeight: 100,
            scrollHeight: 300,
        });
        const stop = bindScrollEdge(scroller);
        expect(scroller.dataset.moreBelow).toBe('true');
        scroller.scrollTop = 200;
        emit('scroll');
        expect(scroller.dataset.moreBelow).toBe('false');
        stop();
    });

    it('updates more-below when the rows change size without a scroll', () => {
        const { scroller } = createScroller({ scrollTop: 0 });
        const stop = bindScrollEdge(scroller);
        expect(scroller.dataset.moreBelow).toBe('false');
        // A collapsed group was revealed: the list grew past the viewport.
        Object.assign(scroller, { scrollHeight: 260 });
        observed.resize();
        expect(scroller.dataset.moreBelow).toBe('true');
        stop();
    });
});

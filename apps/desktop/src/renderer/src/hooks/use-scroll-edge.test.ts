import { describe, expect, it } from 'vitest';

import { bindScrollEdge } from './use-scroll-edge';

function createScroller(scrollTop: number): {
    emit: (type: string) => void;
    scroller: HTMLElement;
} {
    const listeners = new Map<string, Set<EventListener>>();
    const scroller = {
        scrollTop,
        dataset: {} as DOMStringMap,
        addEventListener(type: string, listener: EventListener) {
            const registered = listeners.get(type) ?? new Set<EventListener>();
            registered.add(listener);
            listeners.set(type, registered);
        },
        removeEventListener(type: string, listener: EventListener) {
            listeners.get(type)?.delete(listener);
        },
    } as HTMLElement;
    return {
        scroller,
        emit(type: string) {
            const registered = listeners.get(type) ?? new Set<EventListener>();
            for (const listener of registered) listener(new Event(type));
        },
    };
}

describe('bindScrollEdge', () => {
    it('publishes false before any scroll when the list is at the top', () => {
        const { scroller } = createScroller(0);
        const stop = bindScrollEdge(scroller);
        expect(scroller.dataset.scrolled).toBe('false');
        stop();
    });

    it('publishes true while scrollTop is past the start edge, then false when it returns', () => {
        const { emit, scroller } = createScroller(0);
        const stop = bindScrollEdge(scroller);
        scroller.scrollTop = 24;
        emit('scroll');
        expect(scroller.dataset.scrolled).toBe('true');
        scroller.scrollTop = 0;
        emit('scroll');
        expect(scroller.dataset.scrolled).toBe('false');
        stop();
    });
});

import { describe, expect, it, vi } from 'vitest';

import { createToastStore, TOAST_DURATION_MS } from '../toast-store';

const fakeTimers = () => {
    const pending = new Map<number, { callback: () => void; delayMs: number }>();
    let next = 1;
    return {
        pending,
        timers: {
            clear: (handle: unknown) => pending.delete(handle as number),
            set: (callback: () => void, delayMs: number) => {
                const handle = next++;
                pending.set(handle, { callback, delayMs });
                return handle;
            },
        },
    };
};

describe('toast store', () => {
    it('shows one toast and removes it after the duration', () => {
        const { pending, timers } = fakeTimers();
        const store = createToastStore(timers);
        store.show('success', 'Message copied');
        expect(store.getSnapshot()).toMatchObject({ message: 'Message copied', tone: 'success' });
        const timer = pending.values().next().value;
        expect(timer?.delayMs).toBe(TOAST_DURATION_MS);
        timer?.callback();
        expect(store.getSnapshot()).toBeUndefined();
    });

    it('replaces the current toast and restarts the timer', () => {
        const { pending, timers } = fakeTimers();
        const store = createToastStore(timers);
        store.show('success', 'first');
        const first = store.getSnapshot();
        store.show('error', 'second', 'why');
        expect(pending.size).toBe(1);
        expect(store.getSnapshot()).toMatchObject({
            detail: 'why',
            message: 'second',
            tone: 'error',
        });
        expect(store.getSnapshot()?.id).not.toBe(first?.id);
    });

    it('gives an identical repeat a new id so it is announced again', () => {
        const store = createToastStore(fakeTimers().timers);
        store.show('success', 'Link copied');
        const first = store.getSnapshot()?.id;
        store.show('success', 'Link copied');
        expect(store.getSnapshot()?.id).not.toBe(first);
    });

    it('notifies subscribers on show and dismiss, and stops after unsubscribe', () => {
        const store = createToastStore(fakeTimers().timers);
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        store.show('success', 'a');
        store.dismiss();
        expect(listener).toHaveBeenCalledTimes(2);
        store.dismiss();
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
        store.show('success', 'b');
        expect(listener).toHaveBeenCalledTimes(2);
    });
});

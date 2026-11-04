import { describe, expect, it, vi } from 'vitest';

import {
    createToastStore,
    TOAST_ACTION_DURATION_MS,
    TOAST_ACTION_SCREEN_READER_DURATION_MS,
    TOAST_DURATION_MS,
    TOAST_ERROR_DURATION_MS,
    toastAnnouncement,
} from '../toast-store';

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

describe('toast with a screen reader', () => {
    it('keeps an action toast longer only while a screen reader is on', () => {
        const { pending, timers } = fakeTimers();
        const store = createToastStore(timers);
        const action = { label: 'Undo', onPress: vi.fn() };
        store.setScreenReaderEnabled(true);
        store.show('success', 'Session archived', undefined, action);
        expect(pending.values().next().value?.delayMs).toBe(TOAST_ACTION_SCREEN_READER_DURATION_MS);
        store.setScreenReaderEnabled(false);
        store.show('success', 'Session archived', undefined, action);
        expect(pending.values().toArray().at(-1)?.delayMs).toBe(TOAST_ACTION_DURATION_MS);
    });

    it('announces that the action is available', () => {
        const available = (label: string) => `${label} is available`;
        expect(
            toastAnnouncement(
                { action: { label: 'Undo', onPress: vi.fn() }, message: 'Session archived' },
                available,
            ),
        ).toBe('Session archived. Undo is available');
        expect(toastAnnouncement({ detail: 'Why', message: 'Failed' }, available)).toBe(
            'Failed. Why',
        );
    });
});

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

    it('keeps an error toast longer than a success', () => {
        const { pending, timers } = fakeTimers();
        createToastStore(timers).show('error', 'Failed');
        expect(pending.values().next().value?.delayMs).toBe(TOAST_ERROR_DURATION_MS);
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

    it('keeps a toast with an action long enough to reach it, and runs it once', () => {
        const { pending, timers } = fakeTimers();
        const store = createToastStore(timers);
        const onPress = vi.fn();
        store.show('success', 'Session archived', undefined, { label: 'Undo', onPress });
        expect(pending.values().next().value?.delayMs).toBe(TOAST_ACTION_DURATION_MS);
        const id = store.getSnapshot()?.id ?? -1;
        store.runAction(id);
        expect(onPress).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot()).toBeUndefined();
        store.runAction(id);
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('ignores an action press for a toast that was already replaced', () => {
        const store = createToastStore(fakeTimers().timers);
        const onPress = vi.fn();
        store.show('success', 'Session archived', undefined, { label: 'Undo', onPress });
        const stale = store.getSnapshot()?.id ?? -1;
        store.show('success', 'Link copied');
        store.runAction(stale);
        expect(onPress).not.toHaveBeenCalled();
        expect(store.getSnapshot()).toMatchObject({ message: 'Link copied' });
    });
});

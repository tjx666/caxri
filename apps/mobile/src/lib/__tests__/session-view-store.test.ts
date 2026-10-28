import { describe, expect, it, vi } from 'vitest';

import { createSessionViewStore } from '../session-view-store';

describe('createSessionViewStore', () => {
    it('keeps state per Session and falls back to the initial value', () => {
        const store = createSessionViewStore({ open: false });
        store.set('a', { open: true });
        expect(store.get('a')).toEqual({ open: true });
        expect(store.get('b')).toEqual({ open: false });
    });

    it('notifies on a change only and drops a value that returns to initial', () => {
        const initial = { open: false };
        const store = createSessionViewStore(initial);
        const listener = vi.fn();
        store.subscribe(listener);
        store.set('a', initial);
        expect(listener).not.toHaveBeenCalled();
        store.update('a', () => ({ open: true }));
        expect(listener).toHaveBeenCalledTimes(1);
        store.set('a', initial);
        expect(store.get('a')).toBe(initial);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('stops notifying after unsubscribe', () => {
        const store = createSessionViewStore(0);
        const listener = vi.fn();
        store.subscribe(listener)();
        store.set('a', 1);
        expect(listener).not.toHaveBeenCalled();
    });
});

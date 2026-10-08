import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { observeWindowActive } from './window-active';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), so neither `document` nor the
 * window's event target exists. `observeWindowActive` touches exactly three boundaries: `document.hasFocus`, the
 * document element's dataset, and the global focus/blur listeners, so stubbing those drives it deterministically,
 * mirroring `lib/theme-css.test.ts`'s same mock-the-boundary approach for this same missing global.
 */
const dataset: { windowActive?: string } = {};
const listeners = new Map<string, Set<() => void>>();
const hasFocus = vi.fn(() => true);

beforeEach(() => {
    delete dataset.windowActive;
    listeners.clear();
    hasFocus.mockReturnValue(true);
    vi.stubGlobal('document', { documentElement: { dataset }, hasFocus });
    vi.stubGlobal('addEventListener', (type: string, listener: () => void) => {
        const registered = listeners.get(type) ?? new Set<() => void>();
        registered.add(listener);
        listeners.set(type, registered);
    });
    vi.stubGlobal('removeEventListener', (type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function emit(type: string): void {
    const registered = listeners.get(type) ?? [];
    for (const listener of registered) listener();
}

describe('observeWindowActive', () => {
    it('publishes the current focus state before any event arrives', () => {
        const stop = observeWindowActive();

        expect(dataset.windowActive).toBe('true');
        stop();
    });

    /**
     * The title bar's base classes are its active colors, so a window that opens behind another one has to know it is
     * unfocused before the first paint rather than after the first focus event.
     */
    it('publishes an unfocused window as inactive from the start', () => {
        hasFocus.mockReturnValue(false);

        const stop = observeWindowActive();

        expect(dataset.windowActive).toBe('false');
        stop();
    });

    it('republishes when the window gains or loses focus', () => {
        const stop = observeWindowActive();

        hasFocus.mockReturnValue(false);
        emit('blur');
        expect(dataset.windowActive).toBe('false');

        hasFocus.mockReturnValue(true);
        emit('focus');
        expect(dataset.windowActive).toBe('true');
        stop();
    });

    it('stops publishing once torn down, leaving the last value in place', () => {
        const stop = observeWindowActive();

        stop();
        hasFocus.mockReturnValue(false);
        emit('blur');

        expect(dataset.windowActive).toBe('true');
    });
});

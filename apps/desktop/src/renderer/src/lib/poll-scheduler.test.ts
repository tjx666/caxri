import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivePollSnapshot } from './poll-scheduler';
import {
    createVisibilityAwarePoll,
    getActivePolls,
    isDocumentVisible,
    registerPoll,
    subscribeVisibility,
    unregisterPoll,
} from './poll-scheduler';

/**
 * `document` does not exist under Vitest's `node` environment (see `vitest.config.ts`), so every test that touches
 * visibility stubs a minimal `document` with just enough surface (`visibilityState`, `addEventListener`,
 * `removeEventListener`) to drive `subscribeVisibility`/`createVisibilityAwarePoll` deterministically, mirroring
 * `lib/motion.test.ts`'s mock-the-boundary approach.
 */
function stubDocument(initialVisibilityState: DocumentVisibilityState): {
    setVisibilityState: (next: DocumentVisibilityState) => void;
} {
    const listeners = new Set<() => void>();
    const state = { current: initialVisibilityState };
    vi.stubGlobal('document', {
        get visibilityState() {
            return state.current;
        },
        addEventListener: (type: string, listener: () => void) => {
            if (type === 'visibilitychange') listeners.add(listener);
        },
        removeEventListener: (type: string, listener: () => void) => {
            if (type === 'visibilitychange') listeners.delete(listener);
        },
    });
    return {
        setVisibilityState: (next) => {
            state.current = next;
            for (const listener of listeners) listener();
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('registerPoll / unregisterPoll / getActivePolls', () => {
    it('lists a registered poll in the snapshot', () => {
        const id = registerPoll('terminal.resources', 2_000);
        expect(getActivePolls()).toContainEqual({
            id,
            label: 'terminal.resources',
            intervalMs: 2_000,
        });
        unregisterPoll(id);
    });

    it('removes an unregistered poll from the snapshot', () => {
        const id = registerPoll('projectStatus.overview', 60_000);
        unregisterPoll(id);
        expect(getActivePolls().some((poll) => poll.id === id)).toBe(false);
    });

    it('is a no-op to unregister an id that was already removed', () => {
        const id = registerPoll('projectStatus.summary', 60_000);
        unregisterPoll(id);
        expect(() => unregisterPoll(id)).not.toThrow();
    });

    it('returns a snapshot that does not mutate the live registry', () => {
        const id = registerPoll('processExplorer.snapshot', 2_000);
        // Cast away the `readonly` marker to prove the returned array is a detached copy: mutating it must not
        // affect what a later `getActivePolls()` call reports.
        const snapshot = getActivePolls() as ActivePollSnapshot[];
        snapshot.push({ id: -1, label: 'bogus', intervalMs: 0 });
        expect(getActivePolls().some((poll) => poll.id === -1)).toBe(false);
        unregisterPoll(id);
    });
});

describe('isDocumentVisible', () => {
    it('defaults to visible when there is no document (non-DOM environment)', () => {
        vi.stubGlobal('document', undefined);
        expect(isDocumentVisible()).toBe(true);
    });

    it('reflects a hidden document', () => {
        stubDocument('hidden');
        expect(isDocumentVisible()).toBe(false);
    });

    it('reflects a visible document', () => {
        stubDocument('visible');
        expect(isDocumentVisible()).toBe(true);
    });
});

describe('subscribeVisibility', () => {
    it('reports the current visibility on every visibilitychange event', () => {
        const { setVisibilityState } = stubDocument('visible');
        const changes: boolean[] = [];
        const unsubscribe = subscribeVisibility((visible) => changes.push(visible));

        setVisibilityState('hidden');
        setVisibilityState('visible');

        expect(changes).toEqual([false, true]);
        unsubscribe();
    });

    it('stops reporting changes once unsubscribed', () => {
        const { setVisibilityState } = stubDocument('visible');
        const changes: boolean[] = [];
        const unsubscribe = subscribeVisibility((visible) => changes.push(visible));
        unsubscribe();

        setVisibilityState('hidden');

        expect(changes).toEqual([]);
    });
});

describe('createVisibilityAwarePoll', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('registers itself in the poll registry and unregisters on dispose', () => {
        stubDocument('visible');
        const poll = createVisibilityAwarePoll('processExplorer.snapshot', 2_000, () => {});
        const registered = getActivePolls().find(
            (entry) => entry.label === 'processExplorer.snapshot',
        );
        expect(registered).toEqual({
            id: registered?.id,
            label: 'processExplorer.snapshot',
            intervalMs: 2_000,
        });

        poll.dispose();

        expect(getActivePolls().some((entry) => entry.label === 'processExplorer.snapshot')).toBe(
            false,
        );
    });

    it('fires callback on the configured interval while visible', () => {
        stubDocument('visible');
        const callback = vi.fn();
        const poll = createVisibilityAwarePoll('sample', 2_000, callback);

        vi.advanceTimersByTime(2_000);
        vi.advanceTimersByTime(2_000);

        expect(callback).toHaveBeenCalledTimes(2);
        poll.dispose();
    });

    it('never starts the interval when created while hidden', () => {
        stubDocument('hidden');
        const callback = vi.fn();
        const poll = createVisibilityAwarePoll('sample', 2_000, callback);

        vi.advanceTimersByTime(10_000);

        expect(callback).not.toHaveBeenCalled();
        poll.dispose();
    });

    it('pauses the interval when the document becomes hidden', () => {
        const { setVisibilityState } = stubDocument('visible');
        const callback = vi.fn();
        const poll = createVisibilityAwarePoll('sample', 2_000, callback);

        setVisibilityState('hidden');
        vi.advanceTimersByTime(10_000);

        expect(callback).not.toHaveBeenCalled();
        poll.dispose();
    });

    it('fires callback immediately and resumes the interval when visibility is regained', () => {
        const { setVisibilityState } = stubDocument('visible');
        const callback = vi.fn();
        const poll = createVisibilityAwarePoll('sample', 2_000, callback);

        setVisibilityState('hidden');
        setVisibilityState('visible');
        expect(callback).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(2_000);
        expect(callback).toHaveBeenCalledTimes(2);
        poll.dispose();
    });

    it('stops the interval and visibility subscription once disposed', () => {
        const { setVisibilityState } = stubDocument('visible');
        const callback = vi.fn();
        const poll = createVisibilityAwarePoll('sample', 2_000, callback);

        poll.dispose();
        setVisibilityState('hidden');
        setVisibilityState('visible');
        vi.advanceTimersByTime(10_000);

        expect(callback).not.toHaveBeenCalled();
    });
});

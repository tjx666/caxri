import { afterEach, describe, expect, it, vi } from 'vitest';

import { installSharedProfile } from './__tests__/local-storage-profile';
import { createSharedLocalState, removeLocalStorageEntriesByPrefix } from './local-storage';

/**
 * The suite runs under Vitest's `node` environment, so `window` and `localStorage` are genuinely absent until a test
 * installs them. That absence is itself one of the behaviors under test.
 */
function stubStorage(
    entries: Map<string, string>,
    overrides: Partial<Pick<Storage, 'getItem' | 'setItem'>> = {},
): void {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
        ...overrides,
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

const parseAny = (raw: unknown): unknown => raw;

describe('createSharedLocalState storage failures', () => {
    it('reads undefined when storage is unavailable', () => {
        expect(createSharedLocalState('caxri.example', parseAny).read()).toBeUndefined();
    });

    it('reads a stored value and treats a corrupt entry as unset', () => {
        stubStorage(new Map([['caxri.example', '{"width":240}']]));
        expect(createSharedLocalState('caxri.example', parseAny).read()).toEqual({ width: 240 });
        stubStorage(new Map([['caxri.example', '{not json']]));
        expect(createSharedLocalState('caxri.example', parseAny).read()).toBeUndefined();
    });

    it('reads undefined when the read throws', () => {
        stubStorage(new Map(), {
            getItem: () => {
                throw new Error('SecurityError');
            },
        });
        expect(createSharedLocalState('caxri.example', parseAny).read()).toBeUndefined();
    });

    it('serializes a written value under the key', () => {
        const entries = new Map<string, string>();
        stubStorage(entries);
        createSharedLocalState('caxri.example', parseAny).write(['claude', 'shell']);
        expect(entries.get('caxri.example')).toBe('["claude","shell"]');
    });

    it('removes the entry when written undefined', () => {
        const profile = installSharedProfile(new Map([['caxri.example', '"x"']]));
        createSharedLocalState('caxri.example', parseAny).write(undefined);
        expect(profile.entries.has('caxri.example')).toBe(false);
    });

    it('swallows a full or disabled store', () => {
        stubStorage(new Map(), {
            setItem: () => {
                throw new Error('QuotaExceededError');
            },
        });
        const state = createSharedLocalState('caxri.example', parseAny);
        expect(() => state.write({ width: 240 })).not.toThrow();
    });

    it('does nothing on write when storage is unavailable', () => {
        const state = createSharedLocalState('caxri.example', parseAny);
        expect(() => state.write({ width: 240 })).not.toThrow();
    });
});

describe('removeLocalStorageEntriesByPrefix', () => {
    it('removes only entries under the given prefixes', () => {
        const removed: string[] = [];
        vi.stubGlobal('window', {});
        // Real `Storage` enumerates its keys with `Object.keys`, which is what the helper relies on.
        vi.stubGlobal('localStorage', {
            'old.a': '1',
            'old.b': '2',
            'keep': '3',
            'removeItem': (key: string) => removed.push(key),
        });
        removeLocalStorageEntriesByPrefix(['old.']);
        expect(removed).toEqual(['old.a', 'old.b']);
    });
});

describe('createSharedLocalState', () => {
    const parseRecord = (raw: unknown): Record<string, string> =>
        typeof raw === 'object' && raw !== null ? (raw as Record<string, string>) : {};

    it('keeps what two windows each changed, because a patch merges at write time', () => {
        installSharedProfile();
        const windowA = createSharedLocalState('caxri.example', parseRecord);
        const windowB = createSharedLocalState('caxri.example', parseRecord);
        // Both windows started before either wrote, then each collapses a different Project.
        expect(windowA.read()).toEqual({});
        expect(windowB.read()).toEqual({});
        windowA.patch({ projectA: 'user-collapsed' });
        windowB.patch({ projectB: 'user-collapsed' });

        const fresh = createSharedLocalState('caxri.example', parseRecord);
        expect(fresh.read()).toEqual({
            projectA: 'user-collapsed',
            projectB: 'user-collapsed',
        });
    });

    it('removes a field set to undefined without touching the others', () => {
        installSharedProfile(new Map([['caxri.example', '{"a":"1","b":"2"}']]));
        const state = createSharedLocalState('caxri.example', parseRecord);
        expect(state.patch({ a: undefined })).toEqual({ b: '2' });
        expect(state.read()).toEqual({ b: '2' });
    });

    it('starts from an empty record when the stored value is not an object', () => {
        installSharedProfile(new Map([['caxri.example', '["list"]']]));
        const state = createSharedLocalState('caxri.example', parseRecord);
        expect(state.patch({ a: '1' })).toEqual({ a: '1' });
    });

    it('delivers a write from another window to a subscriber without writing back', () => {
        const profile = installSharedProfile();
        const windowA = createSharedLocalState('caxri.example', parseRecord);
        const windowB = createSharedLocalState('caxri.example', parseRecord);
        const seenByB: Array<Record<string, string>> = [];
        windowB.subscribe((value) => seenByB.push(value));

        windowA.patch({ projectA: 'user-collapsed' });
        const writesBefore = profile.entries.entries().toArray();
        profile.fireStorageEvent('caxri.example');

        expect(seenByB).toEqual([{ projectA: 'user-collapsed' }]);
        // The delivery itself wrote nothing.
        expect(profile.entries.entries().toArray()).toEqual(writesBefore);
    });

    it('ignores another key, answers a clear, and stops after unsubscribe', () => {
        const profile = installSharedProfile(new Map([['caxri.example', '{"a":"1"}']]));
        const state = createSharedLocalState('caxri.example', parseRecord);
        const seen: Array<Record<string, string>> = [];
        const unsubscribe = state.subscribe((value) => seen.push(value));

        profile.fireStorageEvent('caxri.other');
        expect(seen).toEqual([]);

        profile.entries.clear();
        profile.fireStorageEvent(null);
        expect(seen).toEqual([{}]);

        unsubscribe();
        expect(profile.listenerCount()).toBe(0);
    });

    it('does nothing when storage is unavailable', () => {
        const state = createSharedLocalState('caxri.example', parseRecord);
        expect(state.read()).toEqual({});
        expect(() => state.patch({ a: '1' })).not.toThrow();
        expect(state.subscribe(() => {})).toBeTypeOf('function');
    });
});

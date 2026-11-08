import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installSharedProfile } from '../../../../lib/__tests__/local-storage-profile';
import { PORTAL_STORAGE_KEY } from '../portal-persistence';
import { usePortalStore } from '../portal-store';

beforeEach(() => {
    usePortalStore.setState({ bySession: {}, maximizedSessionId: undefined, scopeBySession: {} });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('usePortalStore maximize', () => {
    it('toggles and restores the maximized Portal of one Session', () => {
        const store = usePortalStore.getState();
        store.open('s1', 'a');
        store.toggleMaximized('s1');
        expect(usePortalStore.getState().maximizedSessionId).toBe('s1');
        usePortalStore.getState().restore('s2');
        expect(usePortalStore.getState().maximizedSessionId).toBe('s1');
        usePortalStore.getState().restore('s1');
        expect(usePortalStore.getState().maximizedSessionId).toBeUndefined();
    });

    it('closing the last item also restores the Chat', () => {
        const store = usePortalStore.getState();
        store.open('s1', 'a');
        store.toggleMaximized('s1');
        usePortalStore.getState().closeAll('s1');
        expect(usePortalStore.getState().maximizedSessionId).toBeUndefined();
    });

    it('prunes Sessions that were confirmed deleted', () => {
        const store = usePortalStore.getState();
        store.open('s1', 'a');
        store.open('s2', 'b');
        usePortalStore.getState().pruneSessions((id) => id === 's1');
        expect(Object.keys(usePortalStore.getState().bySession)).toEqual(['s2']);
    });
});

/**
 * The store subscribes to `storage` events when its module loads, so these load a fresh copy after the profile exists.
 */
async function loadStoreInProfile(entries?: Map<string, string>) {
    vi.resetModules();
    const profile = installSharedProfile(entries);
    const { usePortalStore: store } = await import('../portal-store');
    const stored = (): Record<string, { scope?: string }> =>
        JSON.parse(profile.entries.get(PORTAL_STORAGE_KEY) ?? '{}') as Record<
            string,
            { scope?: string }
        >;
    return { profile, store, stored };
}

describe('usePortalStore across windows', () => {
    it("leaves another environment's items when one environment prunes its deleted Sessions", async () => {
        const { store, stored } = await loadStoreInProfile(
            new Map([
                [
                    PORTAL_STORAGE_KEY,
                    JSON.stringify({
                        local1: { paths: ['a'], scope: 'local' },
                        ssh1: { paths: ['b'], scope: 'ssh:host-1' },
                    }),
                ],
            ]),
        );
        // A window that lists only host-1 answers for host-1 alone: ssh1 is gone there, local1 is simply unseen.
        store.getState().pruneSessions((_sessionId, scope) => scope === 'ssh:host-1');

        expect(Object.keys(stored())).toEqual(['local1']);
        expect(Object.keys(store.getState().bySession)).toEqual(['local1']);
    });

    it('merges at write time, so a Portal another window opened survives', async () => {
        const { profile, store, stored } = await loadStoreInProfile();
        store.getState().open('s1', 'a');
        // Another window saved s2 after this one loaded.
        profile.entries.set(
            PORTAL_STORAGE_KEY,
            JSON.stringify({ ...stored(), s2: { paths: ['b'], scope: 'local' } }),
        );
        store.getState().open('s1', 'c');

        expect(Object.keys(stored())).toEqual(['s1', 's2']);
    });

    it("follows another window's change from the storage event without writing it back", async () => {
        const { profile, store } = await loadStoreInProfile();
        const setItem = vi.spyOn(localStorage, 'setItem');
        profile.entries.set(
            PORTAL_STORAGE_KEY,
            JSON.stringify({ other: { paths: ['x'], scope: 'ssh:host-1' } }),
        );
        profile.fireStorageEvent(PORTAL_STORAGE_KEY);

        expect(store.getState().bySession).toEqual({ other: { paths: ['x'], activePath: 'x' } });
        expect(store.getState().scopeBySession).toEqual({ other: 'ssh:host-1' });
        expect(setItem).not.toHaveBeenCalled();
    });
});

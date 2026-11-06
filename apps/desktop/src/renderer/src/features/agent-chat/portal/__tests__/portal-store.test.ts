import { beforeEach, describe, expect, it } from 'vitest';

import { usePortalStore } from '../portal-store';

describe('usePortalStore maximize', () => {
    beforeEach(() => {
        usePortalStore.setState({ bySession: {}, maximizedSessionId: undefined });
    });

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

    it('prunes Sessions that no longer exist', () => {
        const store = usePortalStore.getState();
        store.open('s1', 'a');
        store.open('s2', 'b');
        usePortalStore.getState().pruneSessions((id) => id === 's2');
        expect(Object.keys(usePortalStore.getState().bySession)).toEqual(['s2']);
    });
});

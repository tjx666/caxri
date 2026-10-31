import { beforeEach, describe, expect, it } from 'vitest';

import { useDialogStore } from './dialogs';

describe('modal registration', () => {
    beforeEach(() => {
        useDialogStore.setState({
            archivedSessionsOpen: false,
            paletteOpen: false,
            pathBrowserOpen: false,
            pendingRoot: undefined,
            pendingProjectId: undefined,
            openModalIds: new Set(),
        });
    });

    it('opens and closes the archived Sessions manager', () => {
        useDialogStore.getState().setArchivedSessionsOpen(true);
        expect(useDialogStore.getState().archivedSessionsOpen).toBe(true);

        useDialogStore.getState().setArchivedSessionsOpen(false);
        expect(useDialogStore.getState().archivedSessionsOpen).toBe(false);
    });

    it('reports no modal open when the registry is empty', () => {
        expect(useDialogStore.getState().isModalOpen()).toBe(false);
    });

    it('reports a modal open once an id is registered', () => {
        useDialogStore.getState().registerModal('settings-1');

        expect(useDialogStore.getState().isModalOpen()).toBe(true);
        expect(useDialogStore.getState().openModalIds.has('settings-1')).toBe(true);
    });

    it('reports no modal open again once the only registered id is unregistered', () => {
        const store = useDialogStore.getState();
        store.registerModal('settings-1');
        store.unregisterModal('settings-1');

        expect(useDialogStore.getState().isModalOpen()).toBe(false);
    });

    it('keeps a modal open while at least one other id remains registered', () => {
        const store = useDialogStore.getState();
        store.registerModal('settings-1');
        store.registerModal('palette-1');
        store.unregisterModal('settings-1');

        expect(useDialogStore.getState().isModalOpen()).toBe(true);
        expect(useDialogStore.getState().openModalIds.has('palette-1')).toBe(true);
    });

    it('is idempotent when the same id is registered twice, as React StrictMode does', () => {
        const store = useDialogStore.getState();
        store.registerModal('settings-1');
        const afterFirst = useDialogStore.getState().openModalIds;
        store.registerModal('settings-1');
        const afterSecond = useDialogStore.getState().openModalIds;

        expect(afterSecond.size).toBe(1);
        // Re-registering an already-registered id must be a no-op state update, not a
        // new Set, so unrelated subscribers do not re-render.
        expect(afterSecond).toBe(afterFirst);
    });

    it('is a no-op to unregister an id that was never registered', () => {
        const store = useDialogStore.getState();
        store.unregisterModal('never-registered');

        expect(useDialogStore.getState().openModalIds.size).toBe(0);
    });

    it('survives a StrictMode-style unregister/register churn for the same id', () => {
        const store = useDialogStore.getState();
        store.registerModal('settings-1');
        store.unregisterModal('settings-1');
        store.registerModal('settings-1');

        expect(useDialogStore.getState().openModalIds.size).toBe(1);
        expect(useDialogStore.getState().isModalOpen()).toBe(true);
    });
});

describe('Session search seed', () => {
    beforeEach(() => {
        useDialogStore.setState({
            sessionSearchOpen: false,
            sessionSearchRequest: { id: 0, seed: {} },
        });
    });

    it('opens on the Where filter and Project the opener names', () => {
        useDialogStore.getState().openSessionSearch({ status: 'external', projectId: 'project-1' });

        expect(useDialogStore.getState()).toMatchObject({
            sessionSearchOpen: true,
            sessionSearchRequest: { id: 1, seed: { status: 'external', projectId: 'project-1' } },
        });
    });

    it('drops an earlier seed when the next open names nothing', () => {
        const store = useDialogStore.getState();
        store.openSessionSearch({ status: 'external', projectId: 'project-1' });
        store.setSessionSearchOpen(false);
        store.openSessionSearch();

        expect(useDialogStore.getState().sessionSearchRequest).toEqual({ id: 2, seed: {} });
    });
});

describe('Settings page', () => {
    beforeEach(() => {
        useDialogStore.setState({
            settingsPageOpen: false,
            settingsRequest: { id: 0, view: 'ui' },
        });
    });

    it('opens the page and issues a fresh request for the asked view', () => {
        useDialogStore.getState().openSettings('keybindings');

        expect(useDialogStore.getState().settingsPageOpen).toBe(true);
        expect(useDialogStore.getState().settingsRequest).toEqual({
            id: 1,
            view: 'keybindings',
            provider: undefined,
        });
    });

    it('issues a new request when opened again while already open, so a deep link still lands', () => {
        useDialogStore.getState().openSettings();
        useDialogStore.getState().openSettings('notifications');

        expect(useDialogStore.getState().settingsPageOpen).toBe(true);
        expect(useDialogStore.getState().settingsRequest.id).toBe(2);
        expect(useDialogStore.getState().settingsRequest.view).toBe('notifications');
    });

    it('closes the page without touching the request it last handled', () => {
        useDialogStore.getState().openSettings('notifications');
        useDialogStore.getState().closeSettings({ restoreFocus: false });

        expect(useDialogStore.getState().settingsPageOpen).toBe(false);
        expect(useDialogStore.getState().settingsRequest).toMatchObject({
            id: 1,
            view: 'notifications',
        });
    });
});

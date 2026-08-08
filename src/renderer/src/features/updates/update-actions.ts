import { create } from 'zustand';

import type { UpdateState } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

interface UpdateStoreState {
    open: boolean;
    state?: UpdateState;
    setOpen(open: boolean): void;
    setState(state: UpdateState): void;
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
    open: false,
    state: undefined,
    setOpen: (open) => set({ open }),
    setState: (state) => set({ state }),
}));

function applyState(state: UpdateState, revealAvailable = false): void {
    useUpdateStore.setState({
        state,
        ...(revealAvailable && state.status === 'available' ? { open: true } : {}),
    });
}

async function requestState(label: string, request: () => Promise<UpdateState>): Promise<void> {
    const state = await tryCommand(label, request);
    if (state) applyState(state);
}

export function checkForUpdates(): void {
    useUpdateStore.getState().setOpen(true);
    void requestState('Unable to check for updates', () => caxri.request('updates.check'));
}

export function downloadUpdate(): void {
    void requestState('Unable to download the update', () => caxri.request('updates.download'));
}

export function cancelUpdateDownload(): void {
    void requestState('Unable to cancel the update download', () =>
        caxri.request('updates.cancel'),
    );
}

export function openDownloadedUpdate(): void {
    void requestState('Unable to open the update', () => caxri.request('updates.open'));
}

/** Keeps the mounted update dialog synchronized with Main-owned download state. */
export function subscribeUpdateState(): () => void {
    let active = true;
    void caxri
        .request('updates.getState')
        .then((state) => {
            if (active) applyState(state, true);
        })
        .catch(() => undefined);
    const unsubscribe = caxri.onEvent((event) => {
        if (event.event === 'updates.state') applyState(event.payload, true);
    });
    return () => {
        active = false;
        unsubscribe();
    };
}

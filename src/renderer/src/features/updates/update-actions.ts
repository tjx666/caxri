import type { UpdateState } from '@shared/types';
import { create } from 'zustand';

import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

interface UpdateStoreState {
    open: boolean;
    state?: UpdateState;
    setOpen(isOpen: boolean): void;
    setState(state: UpdateState): void;
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
    open: false,
    state: undefined,
    setOpen: (isOpen) => set({ open: isOpen }),
    setState: (state) => set({ state }),
}));

function applyState(state: UpdateState, shouldRevealAvailable = false): void {
    useUpdateStore.setState({
        state,
        ...(shouldRevealAvailable && state.status === 'available' && { open: true }),
    });
}

async function requestState(label: string, request: () => Promise<UpdateState>): Promise<void> {
    const state = await tryCommand(label, request);
    if (state) applyState(state);
}

export function checkForUpdates(): void {
    useUpdateStore.getState().setOpen(true);
    // Fire-and-forget: `requestState` reports failures through `tryCommand`'s own toast, so this
    // synchronous-looking wrapper never needs to await the outcome.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void requestState('Unable to check for updates', () => caxri.request('updates.check'));
}

export function downloadUpdate(): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void requestState('Unable to download the update', () => caxri.request('updates.download'));
}

export function cancelUpdateDownload(): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void requestState('Unable to cancel the update download', () =>
        caxri.request('updates.cancel'),
    );
}

export function openDownloadedUpdate(): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void requestState('Unable to open the update', () => caxri.request('updates.open'));
}

/**
Keeps the mounted update dialog synchronized with Main-owned download state.
 */
export function subscribeUpdateState(): () => void {
    let isActive = true;
    async function loadState(): Promise<void> {
        try {
            const state = await caxri.request('updates.getState');
            if (isActive) applyState(state, true);
        } catch {
            // Best-effort initial sync; the `updates.state` event subscription below still keeps
            // the dialog current even if this initial read fails.
        }
    }
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void loadState();
    const unsubscribe = caxri.onEvent((event) => {
        if (event.event === 'updates.state') applyState(event.payload, true);
    });
    return () => {
        isActive = false;
        unsubscribe();
    };
}

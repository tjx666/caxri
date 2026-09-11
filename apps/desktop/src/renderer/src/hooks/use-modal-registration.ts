import { useEffect, useId } from 'react';

import { useDialogStore } from '@/stores/dialogs';

/**
 * Registers a popup instance with the shared modal-open registry while `open` is true, and unregisters on close or
 * unmount. Every consumer of the shared `Dialog` and `Menu` primitives gets this for free, so
 * `useDialogStore.isModalOpen()` (which gates app-wide shortcuts in `commands/execute.ts`) stays correct as new
 * overlays are added without anyone having to remember to OR in another boolean field. A `Set` of `useId()`-derived ids
 * keeps React StrictMode's double-invoked effects idempotent.
 */
export function useModalRegistration(open: boolean | undefined): void {
    const id = useId();
    useEffect(() => {
        if (!open) return;
        useDialogStore.getState().registerModal(id);
        return () => useDialogStore.getState().unregisterModal(id);
    }, [open, id]);
}

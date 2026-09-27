import { useId, useLayoutEffect } from 'react';

import { useDialogStore } from '@/stores/dialogs';

/**
 * Registers a popup instance with the shared modal-open registry while `open` is true, and unregisters on close or
 * unmount. Every consumer of the shared `Dialog` and `Menu` primitives gets this for free, so
 * `useDialogStore.isModalOpen()` (which gates app-wide shortcuts in `commands/execute.ts`) stays correct as new
 * overlays are added without anyone having to remember to OR in another boolean field. A `Set` of `useId()`-derived ids
 * keeps React StrictMode's double-invoked effects idempotent.
 *
 * `useLayoutEffect` rather than `useEffect`, because unregistering is a passive effect otherwise: it would not run
 * until React flushes effects on its own schedule, which a busy main thread (a picker's own async open, Monaco's lazy
 * import) can push past the very next keystroke. A shortcut typed in that gap — including the one that would reopen the
 * picker that just closed — reads `isModalOpen()` as still true and is silently swallowed even though the app already
 * decided to close the dialog (issue #1093). A layout effect commits synchronously in the same turn as the `open`
 * prop's own state update, so by the time the browser can dispatch another keydown the unregister has already happened
 * — no keystroke is queued or reordered, the stale read is just never possible.
 */
export function useModalRegistration(open: boolean | undefined): void {
    const id = useId();
    useLayoutEffect(() => {
        if (!open) return;
        useDialogStore.getState().registerModal(id);
        return () => useDialogStore.getState().unregisterModal(id);
    }, [open, id]);
}

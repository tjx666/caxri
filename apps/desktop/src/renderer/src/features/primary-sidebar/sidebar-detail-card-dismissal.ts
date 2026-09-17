import { useDialogStore } from '../../stores/dialogs';

/**
 * Capture Escape before Xterm consumes it, while yielding ownership to modals. Modal opening also closes an open
 * sidebar detail card when an inert sidebar prevents its normal blur cleanup.
 */
export function sidebarDetailCardDismissal(close: () => void): () => void {
    const closeOnEscape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || useDialogStore.getState().isModalOpen()) return;
        event.preventDefault();
        event.stopPropagation();
        close();
    };
    const unsubscribe = useDialogStore.subscribe((state) => {
        if (state.isModalOpen()) close();
    });
    addEventListener('keydown', closeOnEscape, { capture: true });
    return () => {
        unsubscribe();
        removeEventListener('keydown', closeOnEscape, { capture: true });
    };
}

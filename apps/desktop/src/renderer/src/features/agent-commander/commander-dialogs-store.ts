import { createStore } from '../../lib/store';
import { useDialogStore } from '../../stores/dialogs';

interface CommanderDialogsState {
    /**
     * Whether the window's own Command Palette is open.
     */
    isPaletteOpen: boolean;
    /**
     * The open Clear Commander Data dialog, carried as a bumped revision so each open re-reads what there is to clear
     * and starts from the default selection instead of the previous one.
     */
    clearDataRequestId?: number;
    /**
     * The last revision handed out. It keeps counting while the dialog is closed, so no two opens share an ID.
     */
    lastClearDataRequestId: number;
}

/**
 * The Agent Commander window's own dialogs. The window does not mount the Workbench's dialog store owners, so its
 * palette and Clear Commander Data dialog keep their open state here.
 */
export const useCommanderDialogsStore = createStore<CommanderDialogsState>(
    'commander-dialogs',
    () => ({ isPaletteOpen: false, lastClearDataRequestId: 0 }),
);

export function setCommanderPaletteOpen(isPaletteOpen: boolean): void {
    useCommanderDialogsStore.setState({ isPaletteOpen });
}

/**
 * Opens the palette unless a dialog is already open, as the Workbench's `runCommand` gate does. A palette over Clear
 * Commander Data could reopen that dialog and drop the user's selection, or stack a second dialog on the first.
 */
export function requestCommanderPalette(): void {
    if (!useDialogStore.getState().isModalOpen()) setCommanderPaletteOpen(true);
}

export function openCommanderClearData(): void {
    useCommanderDialogsStore.setState((state) => ({
        isPaletteOpen: false,
        clearDataRequestId: state.lastClearDataRequestId + 1,
        lastClearDataRequestId: state.lastClearDataRequestId + 1,
    }));
}

/**
 * Closes the Clear Commander Data dialog. A clear that finishes after the user closed the dialog and opened it again
 * passes its own request ID, so it does not close the newer one.
 */
export function closeCommanderClearData(requestId?: number): void {
    useCommanderDialogsStore.setState((state) =>
        requestId === undefined || state.clearDataRequestId === requestId
            ? { clearDataRequestId: undefined }
            : state,
    );
}
